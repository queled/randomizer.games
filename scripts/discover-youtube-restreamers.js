#!/usr/bin/env node
/**
 * Discover the YouTube channels that archive restreams
 *
 * The restreamers' YouTube channels are not listed anywhere, and a channel named
 * like a Twitch restreamer is often someone else. Candidates come from:
 *   - the channels set by hand (MANUAL_CHANNELS) and those of the videos Mido's House links;
 *   - the YouTube channel named like each Twitch restreamer of Mido's House (1 unit each);
 *   - YouTube searches for each OoTR tournament, then in each restream language
 *     (100 units each, --max-searches a run; a search is made once, kept in `youtubesearches`).
 * A channel found by a search is a candidate only when one of the videos found is a
 * restream of a race in the base. A candidate is kept (`youtubechannels`, status
 * accepted) once at least MIN_MATCHES of its uploads are restreams of different races
 * in the base (helpers/youtube-restreams.js), players' own channels aside; else
 * rejected, and looked at again after REVALIDATE_DAYS.
 * scripts/sync-race-restreams.js then looks for restreams on the accepted channels.
 *
 * Usage:
 *   node scripts/discover-youtube-restreamers.js --dry-run     # candidates and their matches, nothing saved but the searches
 *   node scripts/discover-youtube-restreamers.js --max-searches 45
 *   node scripts/discover-youtube-restreamers.js --revalidate  # every channel again
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const connectDB = require('../config/database');
const { Race, Tournament, YoutubeChannel, YoutubeSearch } = require('../models');
const twitchVods = require('../services/twitch-vods');
const youtube = require('../services/youtube');
const { raceIndex, matchVideo } = require('../helpers/youtube-restreams');
const { normalizeName, LANGUAGE_NAMES } = require('../helpers/restream-titles');

const MIN_MATCHES = 2;
const REVALIDATE_DAYS = 90;
// Uploads read per channel, newest first
const MAX_UPLOADS = 5000;
// Channels checked by hand (channel id → Twitch channel it archives)
const MANUAL_CHANNELS = {
  UCd3Qyn3yRGaOzEIZojyq2CA: 'zeldaspeedruns',
  UCVVKtZgs5O5M4ZeAvw_EUmg: 'zeldaspeedrunsde',
  UCe_uLJvuvlohlZ6RPNClkLw: 'aosuna',
  UCho0rakwbqB87CDoE6x5CuA: 'randomizerbrasil',
  UCRg3lnaAXr2wH2py2Jy34HA: null,
  UChfm7rmNqD6k3Ri_Ze32t5A: null
};
// Searches of a tournament: its name, then with each restream language
const QUERY_LANGUAGES = ['', 'français', 'deutsch', 'español', 'português'];
// Games whose tournaments are searched (racetime.gg categories)
const SEARCHED_CATEGORIES = ['ootr'];

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { dryRun: false, maxSearches: 45, revalidate: false };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--dry-run': opts.dryRun = true; break;
      case '--revalidate': opts.revalidate = true; break;
      case '--max-searches': opts.maxSearches = Math.max(0, parseInt(args[++i], 10) || 0); break;
    }
  }
  return opts;
}

// "OoTR <Event> - Main Tournament" → "Ocarina of Time Randomizer <Event>": YouTube reads "OoTR" as "root"
function tournamentQuery(name) {
  const base = String(name).split(' - ')[0].replace(/^(?:ootr|oot randomizer|ocarina of time randomizer)\b:?\s*/i, '').trim();
  return `Ocarina of Time Randomizer ${base}`;
}

// Twitch restreamers of Mido's House and Hyrule Town Hall, with the language they restream in most
function twitchRestreamers(tournaments) {
  const counts = new Map();
  for (const t of tournaments) {
    const entries = [...((t.midosHouse && t.midosHouse.pastRestreams) || []), ...((t.midosHouse && t.midosHouse.schedule) || [])];
    for (const stream of entries.flatMap(e => e.restreams || [])) {
      const login = twitchVods.twitchLogin(stream.url) || twitchVods.twitchLogin(stream.sourceUrl);
      if (!login) continue;
      const byLanguage = counts.get(login) || new Map();
      byLanguage.set(stream.language, (byLanguage.get(stream.language) || 0) + 1);
      counts.set(login, byLanguage);
    }
  }
  return new Map([...counts].map(([login, byLanguage]) => [login, [...byLanguage].sort((a, b) => b[1] - a[1])[0][0]]));
}

async function main() {
  const opts = parseArgs();
  if (!youtube.hasKey()) {
    console.log('YOUTUBE_API_KEY manquant : rien à faire');
    return;
  }
  if (opts.dryRun) console.log('📋 Mode DRY-RUN : seules les recherches YouTube sont gardées (pour ne pas les refaire)');
  await connectDB();

  const races = await Race.find({ tournamentId: { $ne: null }, status: 'finished', url: /^\/[^/]+\/[^/]+$/ })
    .select('_id url category startedAt tournamentId tiebreak entrants.userName').lean();
  const tournaments = await Tournament.find({ _id: { $in: [...new Set(races.map(r => String(r.tournamentId)))] } })
    .select('_id name startDate endDate midosHouse.site midosHouse.series midosHouse.event midosHouse.pastRestreams midosHouse.schedule').lean();
  const byId = new Map(tournaments.map(t => [String(t._id), t]));
  races.forEach(r => { r.tournament = byId.get(String(r.tournamentId)); });
  const index = raceIndex(races);
  console.log(`🏁 ${races.length} races de ${tournaments.length} tournois`);

  // Candidates: channel id → { source, twitchLogin }
  const candidates = new Map();
  const add = (id, fields) => { if (id && !candidates.has(id)) candidates.set(id, fields); };
  Object.entries(MANUAL_CHANNELS).forEach(([id, twitchLogin]) => add(id, { source: 'manual', twitchLogin }));

  const linkedIds = tournaments.flatMap(t => ((t.midosHouse && t.midosHouse.pastRestreams) || [])
    .flatMap(r => r.restreams || []).map(s => youtube.videoId(s.vodUrl) || youtube.videoId(s.sourceUrl)).filter(Boolean));
  for (const video of (await youtube.getVideos(linkedIds)).values()) add(video.snippet.channelId, { source: 'midos' });

  const known = new Map((await YoutubeChannel.find().lean()).map(c => [c.channelId, c]));
  const restreamers = twitchRestreamers(tournaments);
  const linkedLogins = new Set([...known.values()].map(c => c.twitchLogin).filter(Boolean));
  for (const login of restreamers.keys()) {
    if (linkedLogins.has(login) || Object.values(MANUAL_CHANNELS).includes(login)) continue;
    const channel = await youtube.getChannelByHandle(login);
    if (channel) add(channel.id, { source: 'handle', twitchLogin: login });
  }

  // Searches not made yet, every tournament's name first, newest tournaments first
  const searched = await YoutubeSearch.find().lean();
  const found = searched.flatMap(s => s.videos || []);
  const done = new Set(searched.map(s => s.query));
  const searchedTournaments = tournaments
    .filter(t => races.some(r => String(r.tournamentId) === String(t._id) && SEARCHED_CATEGORIES.includes(r.category)))
    .sort((a, b) => new Date(b.startDate || 0) - new Date(a.startDate || 0));
  const queries = QUERY_LANGUAGES.flatMap(language => searchedTournaments.map(t => ({ tournament: t, query: `${tournamentQuery(t.name)} ${language}`.trim() })))
    .filter(q => !done.has(q.query));
  let searches = 0;
  for (const { tournament, query } of queries.slice(0, opts.maxSearches)) {
    const start = new Date(tournament.startDate || 0).getTime();
    const end = new Date(tournament.endDate || tournament.startDate || Date.now()).getTime();
    let results;
    try {
      results = await youtube.searchVideos(query, { after: start - 7 * 24 * 3600 * 1000, before: Math.min(Date.now(), end + 120 * 24 * 3600 * 1000) });
    } catch (error) {
      if (youtube.isQuotaError(error)) { console.log('   ⏸️  Quota YouTube atteint : la suite au prochain passage'); break; }
      throw error;
    }
    const videos = results.map(r => ({ videoId: r.videoId, channelId: r.channelId }));
    found.push(...videos);
    await YoutubeSearch.updateOne({ query }, { $set: { tournamentId: tournament._id, videos, searchedAt: new Date() } }, { upsert: true });
    searches++;
  }
  // Channels of the videos found that are a restream of a race
  const foundChannels = new Map();
  const unknown = found.filter(v => !candidates.has(v.channelId) && !known.has(v.channelId));
  const foundVideos = await youtube.getVideos(unknown.map(v => v.videoId));
  for (const video of foundVideos.values()) {
    const channel = { title: video.snippet.channelTitle, handle: '' };
    if (matchVideo(video, index, channel).length) foundChannels.set(video.snippet.channelId, video.snippet.channelTitle);
  }
  [...foundChannels.keys()].forEach(id => add(id, { source: 'search' }));
  known.forEach((k, id) => add(id, { source: k.source, twitchLogin: k.twitchLogin }));
  console.log(`🔍 ${searches} recherche(s) YouTube, ${Math.max(0, queries.length - searches)} restante(s) ; ${new Set(found.map(v => v.channelId)).size} chaîne(s) dans les résultats, dont ${foundChannels.size} avec un restream ; ${candidates.size} chaîne(s) candidate(s)`);

  // Channels to (re)validate
  const stale = Date.now() - REVALIDATE_DAYS * 24 * 3600 * 1000;
  const toCheck = [...candidates].filter(([id, c]) => {
    const k = known.get(id);
    return opts.revalidate || !k || !k.validatedAt || new Date(k.validatedAt).getTime() < stale || (c.source === 'manual' && k.status !== 'accepted');
  });
  const channels = await youtube.getChannels(toCheck.map(([id]) => id));
  const oldest = new Date(Math.min(...races.map(r => new Date(r.startedAt).getTime())));
  const results = [];
  for (const [id, candidate] of toCheck) {
    const channel = channels.get(id);
    if (!channel) continue;
    let uploads;
    try {
      uploads = await youtube.getUploads(channel, oldest, MAX_UPLOADS);
    } catch (error) {
      if (youtube.isQuotaError(error)) { console.log('   ⏸️  Quota YouTube atteint : la suite au prochain passage'); break; }
      // No uploads at all
      if (error.response && error.response.status === 404) continue;
      throw error;
    }
    const matched = new Map();
    const audio = new Map();
    for (const video of uploads) {
      const found = matchVideo(video, index, channel);
      found.forEach(f => matched.set(String(f.race._id), { race: f.race, title: video.snippet.title }));
      const code = String(video.snippet.defaultAudioLanguage || video.snippet.defaultLanguage || '').split('-')[0];
      if (found.length && LANGUAGE_NAMES[code]) audio.set(code, (audio.get(code) || 0) + 1);
    }
    // The Twitch restreamer the channel is named after ("123<login>", "<login> VODs"), whose language Mido's House gives;
    // not "<login> <country>", another channel of the same team
    const namedAfterLogin = name => [...restreamers.keys()].find(login => {
      const n = normalizeName(login);
      return n.length >= 4 && name.includes(n) && /^(?:\d|tv|vods?|yt|replays?)*$/.test(name.replace(n, ''));
    });
    const namedAfter = namedAfterLogin(normalizeName(channel.title)) || namedAfterLogin(normalizeName(channel.handle));
    const twitchLogin = candidate.twitchLogin || (known.get(id) && known.get(id).twitchLogin) || namedAfter || null;
    const topAudio = [...audio].sort((a, b) => b[1] - a[1])[0];
    const accepted = candidate.source === 'manual' || candidate.source === 'midos' || matched.size >= MIN_MATCHES;
    results.push({
      channelId: id, title: channel.title, handle: channel.handle, twitchLogin,
      language: (twitchLogin && restreamers.get(twitchLogin)) || (topAudio && LANGUAGE_NAMES[topAudio[0]]) || null,
      source: candidate.source, status: accepted ? 'accepted' : 'rejected', matchedRaces: matched.size, validatedAt: new Date(),
      uploads: uploads.length, examples: [...matched.values()].slice(0, 3)
    });
  }

  results.sort((a, b) => (a.status === b.status ? b.matchedRaces - a.matchedRaces : a.status === 'accepted' ? -1 : 1));
  for (const r of results) {
    if (r.status === 'rejected' && !r.matchedRaces) continue;
    console.log(`\n${r.status === 'accepted' ? '✅' : '❌'} ${r.title} (${r.channelId}) [${r.source}${r.twitchLogin ? ` · twitch.tv/${r.twitchLogin}` : ''}${r.language ? ` · ${r.language}` : ''}] : ${r.matchedRaces} race(s) sur ${r.uploads} vidéo(s)`);
    r.examples.forEach(e => console.log(`     ${e.race.url} (${e.race.tournament ? e.race.tournament.name : '?'}) « ${e.title} »`));
  }
  const rejectedSilently = results.filter(r => r.status === 'rejected' && !r.matchedRaces).length;
  console.log(`\n📊 ${results.filter(r => r.status === 'accepted').length} chaîne(s) gardée(s), ${results.filter(r => r.status === 'rejected').length} écartée(s) (dont ${rejectedSilently} sans aucune race)`);

  if (!opts.dryRun) {
    for (const { uploads, examples, ...doc } of results) {
      await YoutubeChannel.updateOne({ channelId: doc.channelId }, { $set: doc }, { upsert: true });
    }
  }
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error.response && error.response.data ? JSON.stringify(error.response.data.error) : error);
  await mongoose.disconnect();
  process.exit(1);
});
