/**
 * Which tournament races a YouTube video is the restream of: shared by the search for
 * restreams (scripts/sync-race-restreams.js) and the discovery of the channels that
 * restream (scripts/discover-youtube-restreamers.js).
 */

const youtube = require('../services/youtube');
const { normalizeName, titleFitsEvent, titleNamesRace } = require('./restream-titles');

const SAME_RACE_MS = 3600 * 1000;
// An upload comes within days of the race
const UPLOAD_MAX_DELAY_MS = 14 * 24 * 3600 * 1000;
// A broadcast lasts a few hours at most
const BROADCAST_MAX_MS = 12 * 3600 * 1000;

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
 * - else an upload within days of the race, when it fits one race only.
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
    && !(race.entrants || []).some(e => channelNames.includes(normalizeName(e.userName)));

  if (live) {
    const from = new Date(live.actualStartTime).getTime();
    const to = live.actualEndTime ? new Date(live.actualEndTime).getTime() : from + BROADCAST_MAX_MS;
    return index.between(from - BROADCAST_MAX_MS, to).filter(named)
      .map(race => ({ race, vodUrl: youtube.broadcastAt(video, race.startedAt) }))
      .filter(found => found.vodUrl);
  }
  const published = new Date(video.snippet.publishedAt).getTime();
  const matching = index.between(published - UPLOAD_MAX_DELAY_MS, published + SAME_RACE_MS).filter(named);
  return matching.length === 1 ? [{ race: matching[0], vodUrl: `https://www.youtube.com/watch?v=${video.id}` }] : [];
}

module.exports = { fitsTournament, raceIndex, matchVideo };
