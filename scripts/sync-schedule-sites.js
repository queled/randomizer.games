#!/usr/bin/env node
/**
 * Sync Mido's House and Hyrule Town Hall schedules and restreams
 *
 * Reads the races of the events listed on https://midos.house and
 * https://hyruletownhall.com (its fork)
 * and stores them on the start.gg tournament they belong to, linked to
 * matches by start.gg set ID:
 *   - `midosHouse.schedule`: upcoming races, replaced on each sync;
 *   - `midosHouse.pastRestreams`: played races that were restreamed, kept.
 * A race whose racetime.gg room the site gives with its start.gg set is
 * linked to that match, when it is not linked yet.
 * Then finds the VOD of past restreams: the link Mido's House gives when it is
 * already a video, the Twitch past broadcast while Twitch keeps it, or a
 * highlight / upload whose title names both players. VODs Twitch has deleted
 * since are dropped, keeping who restreamed.
 *
 * Events without start.gg sets (Challonge, league, manual brackets) are skipped.
 *
 * Usage:
 *   node scripts/sync-schedule-sites.js                    # events on the home page of both sites
 *   node scripts/sync-schedule-sites.js --site hth         # one site only: midos or hth (repeatable)
 *   node scripts/sync-schedule-sites.js --archive          # finished events too, highlights of any age (one-off backfill)
 *   node scripts/sync-schedule-sites.js --event <series>/<n>      # one event (repeatable), of the first --site (default midos), highlights of any age
 *   node scripts/sync-schedule-sites.js --no-vods          # skip the Twitch VOD lookup
 *   node scripts/sync-schedule-sites.js --dry-run
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const connectDB = require('../config/database');
const { Tournament, Race, Match } = require('../models');
const scheduleSites = require('../services/schedule-sites');
const twitchVods = require('../services/twitch-vods');
const youtube = require('../services/youtube');
const { applyAutoLinkProposals } = require('../services/tournament-autolink');
const { normalizeName, titleFitsEvent } = require('../helpers/restream-titles');

const REQUEST_DELAY_MS = 1000;
// Twitch keeps past broadcasts at most 60 days
const VOD_MAX_AGE_MS = 60 * 24 * 3600 * 1000;
// A room the site gives with its start.gg set: below a link made by hand
const MANUAL_LINK_CONFIDENCE = 999;
const SCHEDULE_LINK_CONFIDENCE = 900;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { dryRun: false, archive: false, vods: true, sites: [], events: [] };
  const eventPaths = [];
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--dry-run': opts.dryRun = true; break;
      case '--archive': opts.archive = true; break;
      case '--no-vods': opts.vods = false; break;
      case '--site': opts.sites.push(scheduleSites.siteOf(args[++i]).key); break;
      case '--event': eventPaths.push(String(args[++i] || '')); break;
    }
  }
  const eventSite = opts.sites[0] || 'midos';
  for (const eventPath of eventPaths) {
    const [series, event] = eventPath.split('/');
    if (series && event) opts.events.push({ site: eventSite, series, event, url: scheduleSites.eventUrl(eventSite, series, event) });
  }
  if (!opts.sites.length) opts.sites = opts.events.length ? [eventSite] : Object.keys(scheduleSites.SITES);
  return opts;
}

function raceKey(race) {
  return `${race.startggSetId}|${new Date(race.startAt).toISOString()}`;
}

function toEntry(race) {
  return {
    startggSetId: race.startggSetId,
    startAt: race.startAt,
    round: race.round,
    game: race.game || undefined,
    entrants: race.entrants,
    roomUrl: race.roomUrl,
    restreams: race.restreams.map(s => ({
      language: s.language,
      url: s.url,
      sourceUrl: s.sourceUrl || s.url,
      vodUrl: s.vodUrl || undefined,
      vodGoneAt: s.vodGoneAt || undefined
    }))
  };
}

// Past restreams from Mido's House, keeping what was found since (channel, VOD) and the races it no longer lists
function mergePastRestreams(existing, fresh) {
  const foundByStream = new Map();
  for (const race of existing) {
    for (const s of race.restreams || []) {
      foundByStream.set(`${raceKey(race)}|${s.sourceUrl || s.url}`, s);
    }
  }
  const byKey = new Map(existing.map(race => [raceKey(race), toEntry(race)]));
  for (const race of fresh) {
    const entry = toEntry(race);
    entry.restreams.forEach(s => {
      const found = foundByStream.get(`${raceKey(race)}|${s.sourceUrl}`);
      if (!found) return;
      s.url = found.url;
      s.vodUrl = found.vodUrl || undefined;
      s.vodGoneAt = found.vodGoneAt || undefined;
    });
    byKey.set(raceKey(race), entry);
  }
  return [...byKey.values()].sort((a, b) => new Date(b.startAt) - new Date(a.startAt));
}

// Game number of each race of a set played over several races, in start order
function numberGames(races) {
  const bySet = new Map();
  for (const race of races) {
    if (!race.startggSetId || !race.startAt) continue;
    if (!bySet.has(race.startggSetId)) bySet.set(race.startggSetId, []);
    bySet.get(race.startggSetId).push(race);
  }
  for (const list of bySet.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.startAt - b.startAt).forEach((race, i) => { race.game = i + 1; });
  }
}

// The tournament most of the event's played races are linked to, if they clearly belong to one
async function findTournamentByRooms(races) {
  const rooms = races.map(r => r.roomUrl && r.roomUrl.replace(/^https:\/\/racetime\.gg/, '')).filter(Boolean);
  if (!rooms.length) return null;
  const counts = new Map();
  for (const race of await Race.find({ url: { $in: rooms }, tournamentId: { $ne: null } }).select('tournamentId').lean()) {
    counts.set(String(race.tournamentId), (counts.get(String(race.tournamentId)) || 0) + 1);
  }
  const [best] = [...counts].sort((a, b) => b[1] - a[1]);
  if (!best || best[1] < 5 || best[1] < rooms.length / 3) return null;
  return Tournament.findById(best[0]).select('_id name midosHouse.pastRestreams').lean();
}

const roomPath = url => String(url || '').replace(/^https:\/\/racetime\.gg/, '');

// Races the site gives with both their racetime.gg room and their start.gg set: linked to that
// match outright (the auto-link only guesses from names and times). A race the auto-link put on
// another match of the tournament moves; one linked by hand stays.
async function linkRooms(tournamentId, races, { dryRun }, stats) {
  const given = races.filter(r => r.roomUrl && r.startggSetId);
  if (!given.length) return;
  const stored = new Map((await Race.find({ url: { $in: given.map(r => roomPath(r.roomUrl)) } })
    .select('url tournamentId startggSetId matchId matchConfidence').lean()).map(r => [r.url, r]));
  const sameTournament = race => !race.tournamentId || String(race.tournamentId) === String(tournamentId);
  const pending = [];
  const moved = [];
  for (const r of given) {
    const race = stored.get(roomPath(r.roomUrl));
    if (!race || race.matchId || !sameTournament(race)) continue;
    if (!race.startggSetId) pending.push(r);
    else if (String(race.startggSetId) !== String(r.startggSetId) && !(Number(race.matchConfidence) >= MANUAL_LINK_CONFIDENCE)) {
      pending.push(r);
      moved.push(race);
    }
  }
  if (!pending.length) return;

  const tournament = await Tournament.findById(tournamentId).populate('game');
  const matchBySet = new Map((tournament.matches || []).map(m => [String(m.startggSetId), m]));
  const proposals = pending.filter(r => matchBySet.has(String(r.startggSetId))).map(r => {
    const match = matchBySet.get(String(r.startggSetId));
    return {
      raceUrl: roomPath(r.roomUrl),
      matchId: String(r.startggSetId),
      matchPlayers: `${(match.player1 && match.player1.name) || '?'} vs ${(match.player2 && match.player2.name) || '?'}`,
      score: SCHEDULE_LINK_CONFIDENCE,
      // The site lists every race of the set: the set was played over that many
      gameNumber: r.game || null
    };
  });
  const movedUrls = new Set(proposals.map(p => p.raceUrl));
  const toMove = moved.filter(race => movedUrls.has(race.url));
  if (!proposals.length) return;
  const label = `${proposals.length} course(s) à rattacher à leur match par la room${toMove.length ? `, dont ${toMove.length} déplacée(s) d’un autre match` : ''}`;
  if (dryRun) {
    console.log(`      🔗 ${label}`);
    toMove.forEach(race => console.log(`         ↪ ${race.url} : set ${race.startggSetId} → ${proposals.find(p => p.raceUrl === race.url).matchId}`));
    stats.roomsLinked += proposals.length;
    stats.roomsMoved += toMove.length;
    return;
  }

  // Off the match the auto-link chose, before linking to the right one
  for (const race of toMove) {
    const match = matchBySet.get(String(race.startggSetId));
    if (match) {
      match.raceUrls = (match.raceUrls || []).filter(url => url !== race.url);
      if (match.raceUrl === race.url) match.raceUrl = match.raceUrls[0] || null;
    }
    await Race.updateOne({ url: race.url }, { $unset: { startggSetId: 1, matchConfidence: 1, matchPlayers: 1, tournamentPhase: 1, tournamentPool: 1, tournamentRound: 1 } });
  }
  if (toMove.length) {
    tournament.markModified('matches');
    await tournament.save();
  }

  const result = await applyAutoLinkProposals({ tournament, proposals, Race, Match });
  console.log(`      🔗 ${result.linked}/${proposals.length} course(s) rattachée(s) à leur match par la room${toMove.length ? `, dont ${toMove.length} déplacée(s) d’un autre match` : ''}`);
  result.errors.slice(0, 5).forEach(error => console.log(`      ⚠️  ${error}`));
  stats.roomsLinked += result.linked;
  stats.roomsMoved += toMove.length;
}

async function syncEvent(ev, { dryRun }, stats, syncedIds) {
  const label = `${ev.site}:${ev.series}/${ev.event}`;
  const { upcoming, past } = await scheduleSites.getEventRaces(ev.series, ev.event, ev.site);
  numberGames(upcoming.concat(past));

  // An event rebuilt from Mido's House (sync-midos-events.js) holds all its races, start.gg sets or not
  const rebuilt = ev.site === 'midos' ? await Tournament.findOne({
    'source.type': 'midos-house', 'source.externalId': `${ev.series}/${ev.event}`
  }).select('_id name midosHouse.pastRestreams').lean() : null;

  // One Mido's House event can map to several start.gg events (e.g. one per bracket)
  const bySlug = new Map();
  if (rebuilt) bySlug.set(null, { upcoming, past, tournament: rebuilt });
  for (const [list, race] of rebuilt ? [] : [...upcoming.map(r => ['upcoming', r]), ...past.map(r => ['past', r])]) {
    if (!race.startggSlug) continue;
    if (!bySlug.has(race.startggSlug)) bySlug.set(race.startggSlug, { upcoming: [], past: [] });
    bySlug.get(race.startggSlug)[list].push(race);
  }
  if (!bySlug.size) {
    // No start.gg sets (Challonge, brackets run on the site): the tournament its racetime.gg rooms are linked to
    const tournament = await findTournamentByRooms(upcoming.concat(past));
    if (!tournament) {
      console.log(`   ⏭️  ${label} : pas de sets start.gg ni de tournoi lié à ses rooms racetime`);
      stats.noStartgg++;
      return;
    }
    bySlug.set(null, { upcoming, past, tournament });
  }

  for (const [slug, races] of bySlug) {
    const tournament = races.tournament || await Tournament.findOne({
      startggSlug: { $in: [slug, slug.replace(/^tournament\//, '')] }
    }).select('_id name midosHouse.pastRestreams').lean();
    if (!tournament) {
      console.log(`   ⚠️  ${label} : aucun tournoi en base pour ${slug}`);
      stats.notFound++;
      continue;
    }

    const schedule = races.upcoming.filter(r => r.startAt).map(toEntry);
    const pastRestreams = mergePastRestreams(
      tournament.midosHouse?.pastRestreams || [],
      races.past.filter(r => r.startAt && r.restreams.length)
    );
    const pastStarts = races.past
      .filter(r => r.startAt && r.startggSetId)
      .map(r => ({ startggSetId: r.startggSetId, startAt: r.startAt, game: r.game || undefined }));
    console.log(`   ✅ ${label} → ${tournament.name} : ${schedule.length} race(s) planifiée(s), ${pastRestreams.length} race(s) passée(s) restreamée(s)`);

    syncedIds.push(tournament._id);
    stats.linked++;
    stats.scheduled += schedule.length;
    stats.pastRestreams += pastRestreams.length;
    if (slug) await linkRooms(tournament._id, races.upcoming.concat(races.past), { dryRun }, stats);
    if (dryRun) continue;

    await Tournament.updateOne({ _id: tournament._id }, {
      $set: {
        'midosHouse.site': ev.site,
        'midosHouse.series': ev.series,
        'midosHouse.event': ev.event,
        'midosHouse.url': ev.url,
        'midosHouse.lastSync': new Date(),
        'midosHouse.schedule': schedule,
        'midosHouse.pastRestreams': pastRestreams,
        'midosHouse.pastStarts': pastStarts
      }
    });
  }
}

// Events gone from the home page of a site read this time are over: their schedule is emptied.
// Events that failed to load this time are left as they were.
async function clearStaleSchedules({ dryRun, sites }, stats, syncedIds, failedEvents) {
  const siteQuery = site => site === 'midos' ? { $in: [null, 'midos'] } : site;
  const query = {
    _id: { $nin: syncedIds },
    'midosHouse.schedule.0': { $exists: true },
    $or: sites.map(site => ({ 'midosHouse.site': siteQuery(site) }))
  };
  if (failedEvents.length) {
    query.$nor = failedEvents.map(ev => ({ 'midosHouse.site': siteQuery(ev.site), 'midosHouse.series': ev.series, 'midosHouse.event': ev.event }));
  }
  const stale = await Tournament.find(query).select('_id name').lean();
  for (const tournament of stale) {
    console.log(`   🧹 ${tournament.name} : plus rien de planifié`);
    stats.cleared++;
    if (!dryRun) {
      await Tournament.updateOne({ _id: tournament._id }, {
        $set: { 'midosHouse.schedule': [], 'midosHouse.lastSync': new Date() }
      });
    }
  }
}

// VODs Twitch or YouTube has deleted since they were found: the link goes, the restreamer stays
async function checkVods({ dryRun }, stats) {
  const tournaments = await Tournament.find({ 'midosHouse.pastRestreams.restreams.vodUrl': { $type: 'string' } })
    .select('_id name midosHouse.pastRestreams').lean();
  const streams = tournaments.flatMap(t => t.midosHouse.pastRestreams.flatMap(r => r.restreams));
  const ids = streams.map(s => twitchVods.videoId(s.vodUrl)).filter(Boolean);
  const youtubeIds = youtube.hasKey() ? streams.map(s => youtube.videoId(s.vodUrl)).filter(Boolean) : [];
  if (!ids.length && !youtubeIds.length) return;

  const existing = ids.length ? await twitchVods.getExistingVideoIds(ids) : new Set();
  const onYoutube = youtubeIds.length ? await youtube.getVideos(youtubeIds) : new Map();
  console.log(`\n🔎 VOD vérifiées : ${new Set(ids).size} sur Twitch (${existing.size} encore en ligne), ${new Set(youtubeIds).size} sur YouTube (${onYoutube.size} encore en ligne)`);
  for (const tournament of tournaments) {
    let gone = 0;
    let named = 0;
    for (const race of tournament.midosHouse.pastRestreams) {
      for (const stream of race.restreams) {
        const id = twitchVods.videoId(stream.vodUrl);
        const youtubeId = youtubeIds.length && youtube.videoId(stream.vodUrl);
        // A YouTube video still online: its channel as who restreamed
        const video = youtubeId && onYoutube.get(youtubeId);
        if (video && !stream.channel) {
          stream.url = youtube.channelUrl(video.snippet.channelId);
          stream.channel = video.snippet.channelTitle;
          named++;
        }
        if (id ? existing.has(id) : !youtubeId || video) continue;
        delete stream.vodUrl;
        stream.vodGoneAt = new Date();
        gone++;
      }
    }
    if (!gone && !named) continue;
    if (gone) console.log(`   🗑️  ${tournament.name} : ${gone} VOD supprimée(s) par Twitch ou YouTube`);
    if (named) console.log(`   ▶️  ${tournament.name} : chaîne YouTube de ${named} restream(s)`);
    stats.vodsGone += gone;
    if (!dryRun) {
      await Tournament.updateOne({ _id: tournament._id }, { $set: { 'midosHouse.pastRestreams': tournament.midosHouse.pastRestreams } });
    }
  }
}

// Mido's House (and Hyrule Town Hall) links older restreams to the video itself: keep it as the VOD,
// and the Twitch channel it belongs to as who restreamed
async function resolveVideoLinks({ dryRun }, stats) {
  const isVideoLink = s => !s.vodUrl && !s.vodGoneAt && (twitchVods.videoId(s.url) || twitchVods.isYoutubeVideo(s.url));
  const tournaments = (await Tournament.find({ 'midosHouse.pastRestreams.restreams.url': /twitch\.tv\/videos\/|youtube\.com|youtu\.be/ })
    .select('_id name midosHouse.pastRestreams').lean())
    .filter(t => t.midosHouse.pastRestreams.some(r => r.restreams.some(isVideoLink)));
  if (!tournaments.length) return;

  const ids = tournaments.flatMap(t => t.midosHouse.pastRestreams.flatMap(r => r.restreams.filter(isVideoLink).map(s => twitchVods.videoId(s.url)).filter(Boolean)));
  const videos = await twitchVods.getVideos(ids);
  console.log(`\n🔗 Liens vidéo des sites : ${new Set(ids).size} sur Twitch (${videos.size} encore en ligne), plus YouTube`);

  for (const tournament of tournaments) {
    let resolved = 0;
    for (const race of tournament.midosHouse.pastRestreams) {
      for (const stream of race.restreams) {
        if (!isVideoLink(stream)) continue;
        stream.sourceUrl = stream.sourceUrl || stream.url;
        const id = twitchVods.videoId(stream.url);
        if (!id) {
          stream.vodUrl = stream.url;
        } else if (videos.has(id)) {
          stream.vodUrl = stream.url;
          stream.url = `https://www.twitch.tv/${videos.get(id).user_login}`;
        } else {
          stream.vodGoneAt = new Date();
        }
        resolved++;
      }
    }
    if (!resolved) continue;
    console.log(`   🔗 ${tournament.name} : ${resolved} lien(s) vidéo`);
    stats.videoLinks += resolved;
    if (!dryRun) {
      await Tournament.updateOne({ _id: tournament._id }, { $set: { 'midosHouse.pastRestreams': tournament.midosHouse.pastRestreams } });
    }
  }
}

// "Game 2", "G3", "Manche 2", "(finale 1/3)"
function titleGame(title) {
  const m = String(title).match(/\b(?:game|g|manche|partie|race)\s*#?(\d)\b/i) || String(title).match(/\b(\d)\s*\/\s*[35]\)/);
  return m ? Number(m[1]) : null;
}

// Names each side of a race can go by: the site's entrants, plus the start.gg names of the match
function raceSides(race, match) {
  const sides = (race.entrants || []).slice(0, 2).map(name => new Set([normalizeName(name)]));
  if (match && sides.length === 2) {
    for (const player of [match.player1, match.player2]) {
      const names = [player && player.name, ...((player && player.members) || [])].map(normalizeName).filter(Boolean);
      const side = sides.find(set => names.some(n => set.has(n) || [...set].some(s => s.length >= 3 && (n.includes(s) || s.includes(n)))));
      if (side) names.forEach(n => side.add(n));
    }
  }
  return sides.map(set => [...set].filter(n => n.length >= 3));
}

// Highlights and uploads (kept by Twitch) whose title names both players of a restreamed race
async function findHighlights({ dryRun, archive }, stats) {
  const now = Date.now();
  const needsVod = (race, stream) => !stream.vodUrl && twitchVods.twitchLogin(stream.url)
    && (archive || new Date(race.startAt).getTime() > now - VOD_MAX_AGE_MS);
  const tournaments = (await Tournament.find({ 'midosHouse.pastRestreams.0': { $exists: true } })
    .select('_id name matches.startggSetId matches.player1 matches.player2 midosHouse.site midosHouse.series midosHouse.event midosHouse.pastRestreams').lean())
    .filter(t => t.midosHouse.pastRestreams.some(r => r.restreams.some(s => needsVod(r, s))));
  if (!tournaments.length) return;

  const logins = tournaments.flatMap(t => t.midosHouse.pastRestreams.flatMap(r => r.restreams.filter(s => needsVod(r, s)).map(s => twitchVods.twitchLogin(s.url))));
  const userIds = await twitchVods.getUserIds(logins);
  const videosByLogin = new Map();
  for (const login of new Set(logins)) {
    videosByLogin.set(login, userIds.has(login) ? await twitchVods.getKeptVideos(userIds.get(login)) : []);
  }
  console.log(`\n✂️  Temps forts : ${[...videosByLogin.values()].reduce((n, v) => n + v.length, 0)} vidéo(s) gardée(s) sur ${videosByLogin.size} chaîne(s)`);

  const used = new Set();
  for (const tournament of tournaments) {
    const matchBySet = new Map((tournament.matches || []).map(m => [String(m.startggSetId), m]));
    let found = 0;
    // Oldest races first, so a highlight goes to the earliest race it can belong to
    for (const race of tournament.midosHouse.pastRestreams.slice().sort((a, b) => new Date(a.startAt) - new Date(b.startAt))) {
      const sides = raceSides(race, matchBySet.get(String(race.startggSetId)));
      if (sides.length < 2 || !sides[0].length || !sides[1].length) continue;
      const start = new Date(race.startAt).getTime();
      for (const stream of race.restreams) {
        if (!needsVod(race, stream)) continue;
        const candidates = (videosByLogin.get(twitchVods.twitchLogin(stream.url)) || [])
          .filter(v => !used.has(v.id) && new Date(v.created_at).getTime() > start - 3600 * 1000)
          .filter(v => {
            const title = normalizeName(v.title);
            if (!sides.every(names => names.some(n => title.includes(n)))) return false;
            if (!titleFitsEvent(v.title, tournament.midosHouse.series, tournament.midosHouse.event, tournament.midosHouse.site)) return false;
            const game = titleGame(v.title);
            return !race.game || !game || game === race.game;
          })
          .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        // Several games of the set and no game number in the titles: no way to tell them apart
        const vod = race.game && !titleGame(candidates[0] && candidates[0].title) && candidates.length > 1 ? null : candidates[0];
        if (!vod) continue;
        used.add(vod.id);
        stream.vodUrl = vod.url;
        delete stream.vodGoneAt;
        found++;
        if (dryRun) console.log(`      ${new Date(race.startAt).toISOString().slice(0, 10)} ${race.entrants.join(' vs ')}${race.game ? ` (game ${race.game})` : ''} → ${vod.created_at.slice(0, 10)} « ${vod.title} »`);
      }
    }
    if (!found) continue;
    console.log(`   ✂️  ${tournament.name} : ${found} temps fort(s)`);
    stats.highlights += found;
    if (!dryRun) {
      await Tournament.updateOne({ _id: tournament._id }, { $set: { 'midosHouse.pastRestreams': tournament.midosHouse.pastRestreams } });
    }
  }
}

// Twitch VODs of the restreams played in the last 60 days that have none yet
async function findVods({ dryRun }, stats) {
  const now = Date.now();
  const needsVod = race => {
    const start = new Date(race.startAt).getTime();
    return start > now - VOD_MAX_AGE_MS && start < now
      && race.restreams.some(s => !s.vodUrl && !s.vodGoneAt && twitchVods.twitchLogin(s.url));
  };

  const tournaments = (await Tournament.find({
    'midosHouse.pastRestreams.startAt': { $gt: new Date(now - VOD_MAX_AGE_MS) }
  }).select('_id name midosHouse.pastRestreams').lean())
    .filter(t => t.midosHouse.pastRestreams.some(needsVod));
  if (!tournaments.length) return;

  const pending = tournaments.flatMap(t => t.midosHouse.pastRestreams.filter(needsVod));
  const logins = pending.flatMap(r => r.restreams.map(s => twitchVods.twitchLogin(s.url)).filter(Boolean));
  console.log(`\n🎬 Recherche des VOD : ${pending.length} race(s), ${new Set(logins).size} chaîne(s)`);

  const userIds = await twitchVods.getUserIds(logins);
  const archivesByLogin = new Map();
  const getArchives = async login => {
    if (!archivesByLogin.has(login)) {
      const userId = userIds.get(login);
      archivesByLogin.set(login, userId ? await twitchVods.getArchives(userId) : []);
    }
    return archivesByLogin.get(login);
  };

  // The racetime.gg start is more precise than the scheduled time
  const roomPaths = pending.map(r => r.roomUrl && r.roomUrl.replace(/^https:\/\/racetime\.gg/, '')).filter(Boolean);
  const startedAtByPath = new Map((await Race.find({ url: { $in: roomPaths } }).select('url startedAt').lean())
    .filter(r => r.startedAt)
    .map(r => [r.url, r.startedAt]));

  for (const tournament of tournaments) {
    let found = 0;
    for (const race of tournament.midosHouse.pastRestreams) {
      if (!needsVod(race)) continue;
      const start = startedAtByPath.get((race.roomUrl || '').replace(/^https:\/\/racetime\.gg/, '')) || race.startAt;
      for (const stream of race.restreams) {
        const login = twitchVods.twitchLogin(stream.url);
        if (stream.vodUrl || stream.vodGoneAt || !login) continue;
        const vodUrl = twitchVods.findVod(await getArchives(login), start);
        if (vodUrl) {
          stream.vodUrl = vodUrl;
          found++;
        }
      }
    }
    if (!found) continue;
    console.log(`   🎬 ${tournament.name} : ${found} VOD trouvée(s)`);
    stats.vods += found;
    if (!dryRun) {
      await Tournament.updateOne({ _id: tournament._id }, { $set: { 'midosHouse.pastRestreams': tournament.midosHouse.pastRestreams } });
    }
  }
}

async function main() {
  const opts = parseArgs();
  if (opts.dryRun) console.log('📋 Mode DRY-RUN : rien n’est écrit en base');

  await connectDB();

  const homepageMode = !opts.events.length && !opts.archive;
  const stats = { linked: 0, scheduled: 0, pastRestreams: 0, roomsLinked: 0, roomsMoved: 0, videoLinks: 0, vods: 0, highlights: 0, vodsGone: 0, cleared: 0, noStartgg: 0, notFound: 0, errors: 0 };
  const syncedIds = [];
  const failedEvents = [];
  // Sites whose home page could be read: only their stale schedules are emptied
  const readSites = [];

  let events = opts.events;
  if (!opts.events.length) {
    events = [];
    for (const site of opts.sites) {
      const name = scheduleSites.SITES[site].name;
      try {
        let siteEvents = await scheduleSites.listCurrentEvents(site);
        if (opts.archive) {
          const current = new Set(siteEvents.map(ev => `${ev.series}/${ev.event}`));
          siteEvents = siteEvents.concat((await scheduleSites.listArchivedEvents(site)).filter(ev => !current.has(`${ev.series}/${ev.event}`)));
        }
        console.log(`\n🏠 ${siteEvents.length} événement(s) sur ${name}`);
        events = events.concat(siteEvents);
        readSites.push(site);
      } catch (error) {
        console.log(`   ❌ ${name} : ${error.message}`);
        stats.errors++;
      }
    }
  }

  for (const ev of events) {
    try {
      await sleep(REQUEST_DELAY_MS);
      await syncEvent(ev, opts, stats, syncedIds);
    } catch (error) {
      console.log(`   ❌ ${ev.site}:${ev.series}/${ev.event} : ${error.message}`);
      failedEvents.push(ev);
      stats.errors++;
    }
  }

  if (homepageMode && readSites.length) await clearStaleSchedules({ ...opts, sites: readSites }, stats, syncedIds, failedEvents);

  if (opts.vods) {
    try {
      await resolveVideoLinks(opts, stats);
      await checkVods(opts, stats);
      await findVods(opts, stats);
      // Backfill (--archive or chosen events): highlights of races of any age
      await findHighlights({ ...opts, archive: opts.archive || opts.events.length > 0 }, stats);
    } catch (error) {
      console.log(`   ❌ VOD Twitch : ${error.message}`);
      stats.errors++;
    }
  }

  console.log(`\n📊 Résumé ${opts.sites.map(site => scheduleSites.SITES[site].name).join(' + ')}`);
  console.log(`Tournois reliés : ${stats.linked}`);
  console.log(`Races planifiées : ${stats.scheduled}`);
  console.log(`Races passées restreamées : ${stats.pastRestreams}`);
  console.log(`Courses rattachées par la room : ${stats.roomsLinked} (dont ${stats.roomsMoved} déplacée(s) d’un autre match)`);
  console.log(`Liens vidéo des sites : ${stats.videoLinks}`);
  console.log(`VOD trouvées : ${stats.vods}`);
  console.log(`Temps forts trouvés : ${stats.highlights}`);
  console.log(`VOD supprimées par Twitch : ${stats.vodsGone}`);
  console.log(`Tournois vidés : ${stats.cleared}`);
  console.log(`Événements sans start.gg : ${stats.noStartgg}`);
  console.log(`Tournois absents de la base : ${stats.notFound}`);
  console.log(`Erreurs : ${stats.errors}`);

  await mongoose.disconnect();
  if (stats.errors) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
