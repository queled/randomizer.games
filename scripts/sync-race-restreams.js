#!/usr/bin/env node
/**
 * Sync race restreams from Twitch titles
 *
 * Mido's House lists the restreams it schedules; races set up by hand
 * (tie-breaks...) have none there. This looks for them on Twitch, on the
 * channels that restream the tournament (according to Mido's House), the
 * community channels restreaming events Mido's House does not list them for
 * and the channel of whoever opened the racetime.gg room, players' own
 * channels aside:
 * a broadcast whose title names the race's players (racetime.gg name or Twitch
 * channel, both of a 1v1, half of a bigger room) and no other event.
 *   - running race: that channel live now;
 *   - finished race: its past broadcast covering the race start, linked at
 *     that moment, looked up until 12 h after the race end;
 *   - --highlights: highlights / uploads (kept by Twitch) for older races, when
 *     the title fits one race of the tournament only.
 * Then on YouTube (with YOUTUBE_API_KEY), where restreamers archive their broadcasts
 * once Twitch deletes them: the uploads of the restreamers' YouTube channels, of the
 * channels Mido's House links videos of for the tournament and of community channels,
 * matched the same way (the broadcast running at the race start, or an upload whose
 * title fits one race only). The tournament page shows Twitch first.
 * Stored in `race.restreams`. VODs Twitch or YouTube has deleted since are dropped,
 * keeping who restreamed.
 *
 * Usage:
 *   node scripts/sync-race-restreams.js                 # running races, finished in the last 2 days
 *   node scripts/sync-race-restreams.js --days 60       # backfill, as far as Twitch keeps past broadcasts
 *   node scripts/sync-race-restreams.js --days 60 --recheck   # again for races already searched (a channel added)
 *   node scripts/sync-race-restreams.js --days 3650 --highlights   # older races: highlights
 *   node scripts/sync-race-restreams.js --days 3650 --youtube-only # older races: YouTube alone
 *   node scripts/sync-race-restreams.js --dry-run
 */

const path = require('path');
const axios = require('axios');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const connectDB = require('../config/database');
const { Race, Tournament } = require('../models');
const twitchVods = require('../services/twitch-vods');
const youtube = require('../services/youtube');
const { normalizeName, titleFitsEvent, titleNamesRace, LANGUAGE_NAMES } = require('../helpers/restream-titles');

const RACETIME_DELAY_MS = 500;
const RETRY_AFTER_END_MS = 12 * 3600 * 1000;
const LIVE_STATUSES = ['open', 'invitational', 'in_progress'];
// A highlight is cut from the broadcast within days of the race
const HIGHLIGHT_MAX_DELAY_MS = 14 * 24 * 3600 * 1000;
const SAME_RACE_MS = 3600 * 1000;
// Community channels restreaming in their language, looked up for every
// tournament; the language comes from the broadcast
const COMMUNITY_RESTREAMERS = ['randomizerbrasil'];
// YouTube channels where Twitch restreamers archive their broadcasts (Twitch login → channel id)
const YOUTUBE_CHANNELS = {
  zeldaspeedruns: 'UCd3Qyn3yRGaOzEIZojyq2CA',
  zeldaspeedruns2: 'UCd3Qyn3yRGaOzEIZojyq2CA',
  zeldaspeedruns_3: 'UCd3Qyn3yRGaOzEIZojyq2CA',
  papy_grant: 'UCn1HT_dXAidJrbP5XDJ6KKA',
  aosuna: 'UCe_uLJvuvlohlZ6RPNClkLw',
  randomizerbrasil: 'UCho0rakwbqB87CDoE6x5CuA',
  slugcentral: 'UCwS4v4KatyOubmrF6IXRrqA'
};
// Community and organisers' YouTube channels, looked up for every tournament
const COMMUNITY_YOUTUBE = ['UCRg3lnaAXr2wH2py2Jy34HA', 'UChfm7rmNqD6k3Ri_Ze32t5A'];
// YouTube keeps broadcasts: races this old at least are looked up there
const YOUTUBE_MIN_DAYS = 30;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { dryRun: false, days: 2, highlights: false, recheck: false, youtubeOnly: false };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--dry-run': opts.dryRun = true; break;
      case '--highlights': opts.highlights = true; break;
      case '--recheck': opts.recheck = true; break;
      case '--youtube-only': opts.youtubeOnly = true; break;
      case '--days': opts.days = Math.max(1, parseInt(args[++i], 10) || 2); break;
    }
  }
  return opts;
}

function roomPath(url) {
  return String(url || '').replace(/^https?:\/\/(?:www\.)?racetime\.gg/i, '').replace(/\/+$/, '').toLowerCase();
}

function channelUrl(login) {
  return `https://twitch.tv/${login}`;
}

const validLogin = login => /^[A-Za-z0-9_]{1,25}$/.test(login || '');

// Players (racetime.gg name and Twitch channel) and who opened the room, from the racetime.gg race data
async function getRoom(raceUrl) {
  const { data } = await axios.get(`https://racetime.gg${raceUrl}/data`, {
    timeout: 20000,
    headers: { 'User-Agent': 'RandomizerWebsite/1.0' }
  });
  const players = (data.entrants || []).map(e => ({
    names: [e.user && e.user.name, e.user && e.user.twitch_name].filter(Boolean),
    twitchName: e.user && validLogin(e.user.twitch_name) ? e.user.twitch_name.toLowerCase() : null
  }));
  const opener = data.opened_by && validLogin(data.opened_by.twitch_name) ? data.opened_by.twitch_name.toLowerCase() : null;
  return { players, opener };
}

/**
 * The tournament's restreamers on Mido's House (login → language), and the
 * channels Mido's House already gives for each race (by room, or by start.gg set
 * and start time).
 */
function midosHouseRestreams(tournament) {
  const languageByLogin = new Map();
  const entries = [...((tournament.midosHouse && tournament.midosHouse.pastRestreams) || []), ...((tournament.midosHouse && tournament.midosHouse.schedule) || [])];
  for (const entry of entries) {
    for (const stream of entry.restreams || []) {
      const login = twitchVods.twitchLogin(stream.url) || twitchVods.twitchLogin(stream.sourceUrl);
      if (login && !languageByLogin.has(login)) languageByLogin.set(login, stream.language);
    }
  }
  const knownFor = race => {
    const start = new Date(race.startedAt).getTime();
    return new Set(entries
      .filter(e => (e.roomUrl && roomPath(e.roomUrl) === roomPath(race.url))
        || (race.startggSetId && String(e.startggSetId) === String(race.startggSetId) && Math.abs(new Date(e.startAt).getTime() - start) < SAME_RACE_MS))
      .flatMap(e => (e.restreams || []).map(s => twitchVods.twitchLogin(s.url) || twitchVods.twitchLogin(s.sourceUrl)))
      .filter(Boolean));
  };
  return { languageByLogin, knownFor };
}

function fitsTournament(title, tournament) {
  const mh = tournament.midosHouse || {};
  return !mh.series || titleFitsEvent(title, mh.series, mh.event, mh.site);
}

function setRestream(race, login, fields) {
  race.restreams = race.restreams || [];
  let entry = race.restreams.find(s => twitchVods.twitchLogin(s.url) === login);
  if (!entry) {
    entry = { url: channelUrl(login) };
    race.restreams.push(entry);
  }
  Object.assign(entry, fields);
  if (entry.vodUrl) delete entry.vodGoneAt;
  return entry;
}

// Running races, and finished ones still within reach of their past broadcast
async function findRestreams({ dryRun, days, recheck }, stats) {
  const now = Date.now();
  const races = (await Race.find({
    tournamentId: { $ne: null },
    url: /^\/[^/]+\/[^/]+$/,
    $or: [
      { status: { $in: LIVE_STATUSES } },
      // Twitch keeps past broadcasts 60 days at most
      { status: 'finished', startedAt: { $gte: new Date(now - Math.min(days, 60) * 24 * 3600 * 1000) } }
    ]
  }).select('_id url status startedAt endedAt startggSetId tournamentId restreams restreamSearchedAt').lean())
    .filter(r => LIVE_STATUSES.includes(r.status) || recheck
      || !r.restreamSearchedAt || new Date(r.restreamSearchedAt).getTime() < new Date(r.endedAt || r.startedAt).getTime() + RETRY_AFTER_END_MS);
  if (!races.length) return;
  console.log(`\n🏁 ${races.length} race(s) de tournoi à chercher`);

  const tournaments = new Map((await Tournament.find({ _id: { $in: [...new Set(races.map(r => String(r.tournamentId)))] } })
    .select('_id name midosHouse.site midosHouse.series midosHouse.event midosHouse.pastRestreams midosHouse.schedule').lean())
    .map(t => [String(t._id), { tournament: t, ...midosHouseRestreams(t) }]));

  // Each race's players and the channels that may restream it
  const pending = [];
  for (const race of races) {
    const context = tournaments.get(String(race.tournamentId));
    if (!context) continue;
    await sleep(RACETIME_DELAY_MS);
    try {
      const { players, opener } = await getRoom(race.url);
      const own = new Set(players.map(p => p.twitchName).filter(Boolean));
      const known = context.knownFor(race);
      const done = new Set((race.restreams || []).filter(s => s.vodUrl).map(s => twitchVods.twitchLogin(s.url)));
      const channels = [...new Set([...context.languageByLogin.keys(), ...COMMUNITY_RESTREAMERS, opener].filter(Boolean))]
        .filter(login => !own.has(login) && !known.has(login) && !done.has(login));
      pending.push({ race, context, players, channels });
    } catch (error) {
      console.log(`   ❌ ${race.url} : ${error.message}`);
      stats.errors++;
    }
  }

  const logins = [...new Set(pending.flatMap(p => p.channels))];
  if (!logins.length) return;
  const userIds = await twitchVods.getUserIds(logins);
  const liveLogins = [...new Set(pending.filter(p => LIVE_STATUSES.includes(p.race.status)).flatMap(p => p.channels))];
  const live = liveLogins.length ? await twitchVods.getLiveStreams(liveLogins) : new Map();
  const archivesByLogin = new Map();
  const getArchives = async login => {
    if (!archivesByLogin.has(login)) {
      archivesByLogin.set(login, userIds.has(login) ? await twitchVods.getArchives(userIds.get(login)) : []);
    }
    return archivesByLogin.get(login);
  };

  for (const { race, context, players, channels } of pending) {
    const isLive = LIVE_STATUSES.includes(race.status);
    let found = 0;
    for (const login of channels) {
      let title = null;
      let vodUrl = null;
      let languageCode = null;
      if (isLive) {
        const stream = live.get(login);
        if (!stream) continue;
        title = stream.title;
        languageCode = stream.language;
      } else {
        const archive = twitchVods.findArchive(await getArchives(login), race.startedAt);
        if (!archive) continue;
        title = archive.video.title;
        vodUrl = archive.url;
        languageCode = archive.video.language;
      }
      if (!titleNamesRace(title, players.map(p => p.names)) || !fitsTournament(title, context.tournament)) continue;
      setRestream(race, login, {
        language: context.languageByLogin.get(login) || LANGUAGE_NAMES[languageCode] || undefined,
        title,
        ...(vodUrl ? { vodUrl } : {})
      });
      found++;
      console.log(`   📺 ${race.url} : ${login}${isLive ? ' (live)' : ''} « ${title} »`);
    }
    stats.races++;
    stats.restreams += found;
    if (!dryRun) {
      const $set = { restreams: race.restreams || [] };
      if (!isLive) $set.restreamSearchedAt = new Date();
      await Race.updateOne({ _id: race._id }, { $set });
    }
  }
}

// Highlights and uploads of the tournaments' restreamers (and community channels) for older races without a restream VOD
async function findHighlights({ dryRun, days }, stats) {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  const races = await Race.find({
    tournamentId: { $ne: null },
    status: 'finished',
    url: /^\/[^/]+\/[^/]+$/,
    startedAt: { $gte: since }
  }).select('_id url startedAt startggSetId tournamentId restreams entrants.userName').lean();
  const tournaments = await Tournament.find({ _id: { $in: [...new Set(races.map(r => String(r.tournamentId)))] } })
    .select('_id name midosHouse.site midosHouse.series midosHouse.event midosHouse.pastRestreams midosHouse.schedule').lean();
  if (!tournaments.length) return;

  const contexts = tournaments.map(t => ({ tournament: t, ...midosHouseRestreams(t) }));
  const logins = [...new Set([...contexts.flatMap(c => [...c.languageByLogin.keys()]), ...COMMUNITY_RESTREAMERS])];
  const userIds = await twitchVods.getUserIds(logins);
  const videosByLogin = new Map();
  for (const login of logins) {
    videosByLogin.set(login, userIds.has(login) ? await twitchVods.getKeptVideos(userIds.get(login)) : []);
  }
  console.log(`\n✂️  Temps forts : ${[...videosByLogin.values()].reduce((n, v) => n + v.length, 0)} vidéo(s) gardée(s) sur ${videosByLogin.size} chaîne(s)`);

  const used = new Set();
  for (const context of contexts) {
    const tournamentRaces = races.filter(r => String(r.tournamentId) === String(context.tournament._id));
    // racetime.gg names only: the Twitch channels would take one call per race
    const playersOf = race => (race.entrants || []).map(e => [e.userName].filter(Boolean));
    const touched = new Set();
    for (const login of new Set([...context.languageByLogin.keys(), ...COMMUNITY_RESTREAMERS])) {
      for (const video of videosByLogin.get(login) || []) {
        if (used.has(video.id) || !fitsTournament(video.title, context.tournament)) continue;
        const created = new Date(video.created_at).getTime();
        const matching = tournamentRaces.filter(race => {
          const start = new Date(race.startedAt).getTime();
          return created > start - SAME_RACE_MS && created < start + HIGHLIGHT_MAX_DELAY_MS
            && titleNamesRace(video.title, playersOf(race));
        });
        // The same players met twice within the delay: no way to tell which race
        if (matching.length !== 1) continue;
        const race = matching[0];
        const own = new Set((race.entrants || []).map(e => String(e.userName || '').toLowerCase()));
        if (own.has(login) || context.knownFor(race).has(login)) continue;
        if ((race.restreams || []).some(s => s.vodUrl && twitchVods.twitchLogin(s.url) === login)) continue;
        used.add(video.id);
        const language = context.languageByLogin.get(login) || LANGUAGE_NAMES[video.language] || undefined;
        setRestream(race, login, { language, title: video.title, vodUrl: video.url });
        touched.add(race);
        stats.highlights++;
        console.log(`   ✂️  ${race.url} : ${login} « ${video.title} »`);
      }
    }
    if (!dryRun) {
      for (const race of touched) await Race.updateOne({ _id: race._id }, { $set: { restreams: race.restreams } });
    }
  }
}

// YouTube videos linked to a restream, Mido's House's and those found here
function youtubeVideoIds(tournament, races) {
  const streams = [...((tournament.midosHouse && tournament.midosHouse.pastRestreams) || []).flatMap(r => r.restreams || []),
    ...races.flatMap(r => r.restreams || [])];
  return new Set(streams.flatMap(s => [youtube.videoId(s.vodUrl), youtube.videoId(s.url)]).filter(Boolean));
}

// Restreams archived on YouTube, for races without one there yet
async function findYoutubeRestreams({ dryRun, days }, stats) {
  const since = new Date(Date.now() - Math.max(days, YOUTUBE_MIN_DAYS) * 24 * 3600 * 1000);
  const races = await Race.find({
    tournamentId: { $ne: null },
    status: 'finished',
    url: /^\/[^/]+\/[^/]+$/,
    startedAt: { $gte: since }
  }).select('_id url startedAt tournamentId restreams entrants.userName').lean();
  const tournaments = await Tournament.find({ _id: { $in: [...new Set(races.map(r => String(r.tournamentId)))] } })
    .select('_id name midosHouse.site midosHouse.series midosHouse.event midosHouse.pastRestreams midosHouse.schedule').lean();
  if (!tournaments.length) return;

  // Each tournament's channels: its Twitch restreamers' YouTube channels, the channels of the videos Mido's House links, the community's
  const contexts = tournaments.map(t => ({ tournament: t, ...midosHouseRestreams(t), races: races.filter(r => String(r.tournamentId) === String(t._id)) }));
  const linked = await youtube.getVideos(contexts.flatMap(c => [...youtubeVideoIds(c.tournament, [])]));
  for (const context of contexts) {
    const languageByChannel = new Map();
    for (const [login, language] of context.languageByLogin) {
      if (YOUTUBE_CHANNELS[login] && !languageByChannel.has(YOUTUBE_CHANNELS[login])) languageByChannel.set(YOUTUBE_CHANNELS[login], language);
    }
    for (const id of youtubeVideoIds(context.tournament, [])) {
      const video = linked.get(id);
      if (video && !languageByChannel.has(video.snippet.channelId)) languageByChannel.set(video.snippet.channelId, undefined);
    }
    COMMUNITY_YOUTUBE.filter(id => !languageByChannel.has(id)).forEach(id => languageByChannel.set(id, undefined));
    context.languageByChannel = languageByChannel;
  }

  const channels = await youtube.getChannels(contexts.flatMap(c => [...c.languageByChannel.keys()]));
  const oldest = new Date(Math.min(...races.map(r => new Date(r.startedAt).getTime())) - SAME_RACE_MS);
  const uploads = new Map();
  for (const channel of channels.values()) uploads.set(channel.id, await youtube.getUploads(channel, oldest));
  console.log(`\n▶️  YouTube : ${[...uploads.values()].reduce((n, v) => n + v.length, 0)} vidéo(s) sur ${uploads.size} chaîne(s)`);

  // racetime.gg names only: the Twitch channels would take one call per race
  const playersOf = race => (race.entrants || []).map(e => [e.userName].filter(Boolean));
  for (const context of contexts) {
    const used = youtubeVideoIds(context.tournament, context.races);
    const touched = new Set();
    for (const [id, channelLanguage] of context.languageByChannel) {
      const channel = channels.get(id);
      if (!channel) continue;
      const channelNames = [channel.title, channel.handle].map(normalizeName).filter(Boolean);
      for (const video of uploads.get(id) || []) {
        const title = video.snippet.title;
        if (used.has(video.id) || !fitsTournament(title, context.tournament)) continue;
        const named = context.races.filter(race => titleNamesRace(title, playersOf(race))
          // A player's own channel is not a restream
          && !(race.entrants || []).some(e => channelNames.includes(normalizeName(e.userName))));
        // The broadcast running at the race start, linked at that moment; else an upload of one race only
        let found = named.map(race => ({ race, vodUrl: youtube.broadcastAt(video, race.startedAt) })).filter(f => f.vodUrl);
        if (!found.length && !(video.liveStreamingDetails && video.liveStreamingDetails.actualStartTime)) {
          const published = new Date(video.snippet.publishedAt).getTime();
          const matching = named.filter(race => {
            const start = new Date(race.startedAt).getTime();
            return published > start - SAME_RACE_MS && published < start + HIGHLIGHT_MAX_DELAY_MS;
          });
          if (matching.length === 1) found = [{ race: matching[0], vodUrl: `https://www.youtube.com/watch?v=${video.id}` }];
        }
        if (!found.length) continue;
        used.add(video.id);
        const audio = String(video.snippet.defaultAudioLanguage || video.snippet.defaultLanguage || '').split('-')[0];
        for (const { race, vodUrl } of found) {
          race.restreams = race.restreams || [];
          let entry = race.restreams.find(s => s.url === youtube.channelUrl(id));
          if (entry && entry.vodUrl) continue;
          if (!entry) {
            entry = { url: youtube.channelUrl(id) };
            race.restreams.push(entry);
          }
          Object.assign(entry, { language: channelLanguage || LANGUAGE_NAMES[audio] || undefined, title, vodUrl, channel: channel.title });
          delete entry.vodGoneAt;
          touched.add(race);
          stats.youtube++;
          console.log(`   ▶️  ${race.url} : ${channel.title} « ${title} »`);
        }
      }
    }
    if (!dryRun) {
      for (const race of touched) await Race.updateOne({ _id: race._id }, { $set: { restreams: race.restreams } });
    }
  }
}

// VODs Twitch or YouTube has deleted since they were found: the link goes, the channel stays
async function checkVods({ dryRun }, stats) {
  const races = await Race.find({ 'restreams.vodUrl': { $type: 'string' } }).select('_id restreams').lean();
  const streams = races.flatMap(r => r.restreams);
  const twitchIds = streams.map(s => twitchVods.videoId(s.vodUrl)).filter(Boolean);
  const youtubeIds = youtube.hasKey() ? streams.map(s => youtube.videoId(s.vodUrl)).filter(Boolean) : [];
  if (!twitchIds.length && !youtubeIds.length) return;

  const existing = twitchIds.length ? await twitchVods.getExistingVideoIds(twitchIds) : new Set();
  const onYoutube = youtubeIds.length ? new Set((await youtube.getVideos(youtubeIds)).keys()) : new Set();
  console.log(`\n🔎 VOD de restreams vérifiées : ${new Set(twitchIds).size} sur Twitch (${existing.size} encore en ligne), ${new Set(youtubeIds).size} sur YouTube (${onYoutube.size} encore en ligne)`);
  for (const race of races) {
    let gone = 0;
    for (const stream of race.restreams) {
      const twitchId = twitchVods.videoId(stream.vodUrl);
      const youtubeId = youtubeIds.length && youtube.videoId(stream.vodUrl);
      if (twitchId ? existing.has(twitchId) : !youtubeId || onYoutube.has(youtubeId)) continue;
      delete stream.vodUrl;
      stream.vodGoneAt = new Date();
      gone++;
    }
    if (!gone) continue;
    stats.vodsGone += gone;
    if (!dryRun) await Race.updateOne({ _id: race._id }, { $set: { restreams: race.restreams } });
  }
}

async function main() {
  const opts = parseArgs();
  if (opts.dryRun) console.log('📋 Mode DRY-RUN : rien n’est écrit en base');

  await connectDB();
  const stats = { races: 0, restreams: 0, highlights: 0, youtube: 0, vodsGone: 0, errors: 0 };

  try {
    await checkVods(opts, stats);
    if (!opts.youtubeOnly) {
      await findRestreams(opts, stats);
      if (opts.highlights) await findHighlights(opts, stats);
    }
  } catch (error) {
    console.log(`   ❌ ${error.message}`);
    stats.errors++;
  }
  if (youtube.hasKey()) {
    try {
      await findYoutubeRestreams(opts, stats);
    } catch (error) {
      console.log(`   ❌ YouTube : ${(error.response && error.response.data && error.response.data.error && error.response.data.error.message) || error.message}`);
      stats.errors++;
    }
  }

  console.log('\n📊 Résumé restreams Twitch et YouTube');
  console.log(`Races cherchées : ${stats.races}`);
  console.log(`Restreams trouvés : ${stats.restreams}`);
  console.log(`Temps forts trouvés : ${stats.highlights}`);
  console.log(`Restreams trouvés sur YouTube : ${stats.youtube}`);
  console.log(`VOD supprimées par Twitch ou YouTube : ${stats.vodsGone}`);
  console.log(`Erreurs : ${stats.errors}`);

  await mongoose.disconnect();
  if (stats.errors) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
