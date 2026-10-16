/**
 * alttp.localhorst.tv — community schedule of ALTTPR, Super Metroid Rando and
 * SMZ3 races (mostly the German community), with their restream channels.
 *
 * Its JSON API is public: events (`/api/events`) and their races, called
 * episodes (`/api/episodes?event[]=<id>`), each with its racetime.gg room and
 * the channels restreaming it. Many events only copy another schedule:
 * SpeedGaming (`external_schedule` "sg:<slug>") or Hyrule Town Hall
 * ("hth:<series>/<event>", episodes with an "hth:" `ext_id`), which
 * sync-schedule-sites.js reads already.
 *
 * Only what the restreams need is kept: no player or crew data.
 */

const axios = require('axios');

const BASE_URL = 'https://alttp.localhorst.tv';
// The API answers 429 "Too Many Attempts" past roughly one request a second
const REQUEST_DELAY_MS = 1500;
const PAGE_SIZE = 100;

const http = axios.create({
  baseURL: BASE_URL,
  timeout: 30000,
  headers: { 'User-Agent': 'RandomizerWebsite/1.0', Accept: 'application/json' },
  // Some titles hold raw control characters, which JSON.parse refuses
  transformResponse: [data => data]
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let lastRequestAt = 0;
async function get(path, params, attempt = 0) {
  const wait = lastRequestAt + REQUEST_DELAY_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
  try {
    const { data } = await http.get(path, { params });
    return JSON.parse(String(data).replace(/[\u0000-\u001f]+/g, ' '));
  } catch (error) {
    if (error.response && error.response.status === 429 && attempt < 3) {
      await sleep(10000 * (attempt + 1));
      return get(path, params, attempt + 1);
    }
    throw error;
  }
}

/** All events: { id, name, title, start, end, game, externalSchedule, url } */
async function listEvents() {
  return (await get('/api/events')).map(e => ({
    id: e.id,
    name: e.name,
    title: e.title,
    start: e.start ? new Date(e.start) : null,
    end: e.end ? new Date(e.end) : null,
    game: e.game || null,
    externalSchedule: e.external_schedule || null,
    url: `${BASE_URL}/events/${encodeURIComponent(e.name)}`
  }));
}

function toEpisode(e) {
  return {
    id: e.id,
    start: e.start ? new Date(e.start) : null,
    extId: e.ext_id || null,
    roomUrl: e.raceroom || null,
    doNotRestream: !!e.do_not_restream,
    channels: (e.channels || []).map(c => ({
      title: c.title || c.short_name || null,
      url: c.stream_link || null,
      languages: Array.isArray(c.languages) ? c.languages : []
    }))
  };
}

/**
 * Races of one event starting after `after` (all of them without it), in start
 * order. The API gives 100 at a time from the given date.
 */
async function getEpisodes(eventId, { after = null } = {}) {
  const episodes = new Map();
  let from = after;
  for (;;) {
    const page = await get('/api/episodes', { 'event[]': eventId, ...(from ? { after: from.toISOString() } : {}) });
    let added = 0;
    for (const e of page) {
      if (episodes.has(e.id)) continue;
      episodes.set(e.id, toEpisode(e));
      added++;
    }
    if (page.length < PAGE_SIZE || !added) break;
    from = new Date(page[page.length - 1].start);
  }
  return [...episodes.values()].sort((a, b) => (a.start || 0) - (b.start || 0));
}

module.exports = { BASE_URL, listEvents, getEpisodes };
