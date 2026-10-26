/**
 * Which tournament races a YouTube video is the restream of: shared by the search for
 * restreams (scripts/sync-race-restreams.js) and the discovery of the channels that
 * restream (scripts/discover-youtube-restreamers.js).
 */

const youtube = require('../services/youtube');
const { normalizeName, titleFitsEvent, titleNamesRace } = require('./restream-titles');

const SAME_RACE_MS = 3600 * 1000;
// An upload comes within weeks of the race
const UPLOAD_MAX_DELAY_MS = 30 * 24 * 3600 * 1000;
// A broadcast lasts a few hours at most
const BROADCAST_MAX_MS = 12 * 3600 * 1000;
const TIEBREAK_RE = /\btie[\s-]?break/i;

// A channel named after one of its players ("<name>_tv", "123<name>"), names of 4 characters at least
function ownChannel(channelNames, race) {
  return (race.entrants || []).map(e => normalizeName(e.userName)).filter(n => n.length >= 4)
    .some(n => channelNames.some(c => c.includes(n) || (c.length >= 4 && n.includes(c))));
}

function fitsTournament(title, tournament) {
  const mh = (tournament && tournament.midosHouse) || {};
  return !mh.series || titleFitsEvent(title, mh.series, mh.event, mh.site);
}

/**
 * Tournament races sorted by start, to look up those around a video's date.
 * @param races finished races with `startedAt`, `entrants.userName` and `tournament`
 */
function raceIndex(races) {
  const sorted = races.filter(r => r.startedAt).map(r => ({ race: r, start: new Date(r.startedAt).getTime() })).sort((a, b) => a.start - b.start);
  const firstFrom = time => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].start < time) lo = mid + 1; else hi = mid;
    }
    return lo;
  };
  return {
    between(from, to) {
      const list = [];
      for (let i = firstFrom(from); i < sorted.length && sorted[i].start <= to; i++) list.push(sorted[i].race);
      return list;
    }
  };
}

// racetime.gg names only: the Twitch channels would take one call per race
const playersOf = race => (race.entrants || []).map(e => [e.userName].filter(Boolean));

/**
 * Races a video is the restream of, with the link to give:
 * - a broadcast archived on YouTube covering the race start, linked at that moment
 *   (every game of a series it covers);
 * - else an upload within weeks of the race, when it fits one race only (a title
 *   saying tie-break picks among the races of the same players the tie-break one).
 * The title names the race's players and no other event; a player's own channel is
 * not a restream.
 * @param channel { title, handle }
 * @returns [{ race, vodUrl }]
 */
function matchVideo(video, index, channel) {
  const title = video.snippet.title;
  const channelNames = [channel.title, channel.handle].map(normalizeName).filter(Boolean);
  const live = video.liveStreamingDetails && video.liveStreamingDetails.actualStartTime ? video.liveStreamingDetails : null;
  const named = race => titleNamesRace(title, playersOf(race)) && fitsTournament(title, race.tournament)
    && !ownChannel(channelNames, race);

  if (live) {
    const from = new Date(live.actualStartTime).getTime();
    const to = live.actualEndTime ? new Date(live.actualEndTime).getTime() : from + BROADCAST_MAX_MS;
    return index.between(from - BROADCAST_MAX_MS, to).filter(named)
      .map(race => ({ race, vodUrl: youtube.broadcastAt(video, race.startedAt) }))
      .filter(found => found.vodUrl);
  }
  const published = new Date(video.snippet.publishedAt).getTime();
  let matching = index.between(published - UPLOAD_MAX_DELAY_MS, published + SAME_RACE_MS).filter(named);
  if (matching.length > 1) matching = matching.filter(race => !!race.tiebreak === TIEBREAK_RE.test(title));
  return matching.length === 1 ? [{ race: matching[0], vodUrl: `https://www.youtube.com/watch?v=${video.id}` }] : [];
}

// Uploads of a restreamer's schedule come weeks or months after the race
const SCHEDULE_UPLOAD_MAX_DELAY_MS = 180 * 24 * 3600 * 1000;
// The same video uploaded again: its length within seconds
const REUPLOAD_MAX_GAP_S = 10;
const GAME_RE = /\b(?:game|match|g)\s*(\d)\b/i;
const PART_RE = /\bpart\s*(\d+)\b/i;
// Words of a tournament name that tell no tournament apart
const GENERIC_WORDS = new Set(['the', 'tournament', 'tournoi', 'community', 'season', 'saison', 'league', 'open', 'cup', 'winter', 'spring', 'summer', 'fall', 'autumn', 'main', 'edition']);

function seconds(isoDuration) {
  const m = String(isoDuration || '').match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : null;
}

/**
 * How many words of the tournament's name (letters in them) a title names; 0 for a title
 * of another year
 */
function tournamentScore(title, name) {
  const words = String(title).toLowerCase().split(/[^a-z0-9]+/);
  const own = String(name).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && /[a-z]/.test(w) && !GENERIC_WORDS.has(w));
  const year = (String(name).match(/\b(20\d\d)\b/) || [])[1];
  if (words.some(w => /^20\d\d$/.test(w) && year && w !== year)) return 0;
  return new Set(own.filter(w => words.includes(w))).size;
}

/**
 * Restreams of a tournament's schedule (`midosHouse.pastRestreams`) archived later as one
 * upload a game, titled with the players' names of the schedule: each pair's uploads go to
 * its scheduled races in order, "Game N" to the Nth race of the series.
 * @param tournament { name, matches, midosHouse.pastRestreams }
 * @param videos uploads of the restreamer's archive channel
 * @param language the channel's language, to keep to the schedule's broadcasts in it
 * @returns [{ roomUrl, video, score }], `score` how much the title names the tournament
 */
function matchScheduleUploads(tournament, videos, language) {
  const gameOf = new Map();
  for (const m of tournament.matches || []) {
    const urls = (m.raceUrls && m.raceUrls.length ? m.raceUrls : [m.raceUrl]).filter(Boolean);
    urls.forEach((url, i) => gameOf.set(url.replace(/^https?:\/\/racetime\.gg/i, ''), urls.length > 1 ? i + 1 : null));
  }
  const pairKey = names => names.map(normalizeName).sort().join('|');
  const entries = ((tournament.midosHouse && tournament.midosHouse.pastRestreams) || [])
    .filter(e => e.roomUrl && (e.entrants || []).length === 2
      && (!language || (e.restreams || []).some(s => !s.language || s.language === language)))
    .map(e => ({ roomUrl: e.roomUrl, start: new Date(e.startAt).getTime(), names: e.entrants, key: pairKey(e.entrants),
      game: gameOf.get(e.roomUrl.replace(/^https?:\/\/racetime\.gg/i, '')) || null }))
    .sort((a, b) => a.start - b.start);

  const byPair = new Map();
  for (const video of videos) {
    const title = video.snippet.title;
    const part = title.match(PART_RE);
    const score = tournamentScore(title, tournament.name);
    if ((part && +part[1] > 1) || !score) continue;
    const named = entries.find(e => titleNamesRace(title, e.names.map(n => [n])));
    if (!named) continue;
    const list = byPair.get(named.key) || [];
    list.push({ video, score, published: new Date(video.snippet.publishedAt).getTime(), game: +((title.match(GAME_RE) || [])[1]) || null,
      length: seconds(video.contentDetails && video.contentDetails.duration) });
    byPair.set(named.key, list);
  }

  const found = [];
  for (const [key, list] of byPair) {
    list.sort((a, b) => a.published - b.published || (a.game || 0) - (b.game || 0));
    const kept = list.filter((v, i) => !list.slice(0, i).some(o => v.length != null && o.length != null
      && Math.abs(v.length - o.length) <= REUPLOAD_MAX_GAP_S && v.game === o.game));
    const free = entries.filter(e => e.key === key);
    const take = (video, fits) => {
      const index = free.findIndex(e => fits(e) && e.start < video.published && video.published - e.start < SCHEDULE_UPLOAD_MAX_DELAY_MS);
      if (index >= 0) found.push({ roomUrl: free.splice(index, 1)[0].roomUrl, video: video.video, score: video.score });
    };
    kept.filter(v => v.game).forEach(v => take(v, e => e.game === v.game));
    kept.filter(v => !v.game).forEach(v => take(v, () => true));
  }
  return found;
}

module.exports = { fitsTournament, raceIndex, matchVideo, ownChannel, matchScheduleUploads };
