/**
 * Mido's House (https://midos.house) — OoTR tournament scheduling.
 *
 * Players schedule their races there (Discord bot in the tournament's server)
 * and restreamers add their channel per language. Its GraphQL API has no
 * restream links nor start.gg set IDs, so the races page is read as HTML:
 * each row carries the start time (data-timestamp), the start.gg set link
 * and one link per restream, titled "<Language> restream".
 */

const axios = require('axios');

const BASE_URL = 'https://midos.house';

const http = axios.create({
  baseURL: BASE_URL,
  timeout: 60000,
  headers: { 'User-Agent': 'RandomizerWebsite/1.0' }
});

// A race still listed as upcoming this long after its start time counts as played
const PLAYED_AFTER_MS = 12 * 3600 * 1000;

// Mido's House can be slow to build big race pages: one retry
async function getPage(url) {
  try {
    return (await http.get(url)).data;
  } catch (error) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    return (await http.get(url)).data;
  }
}

const START_GG_SET_RE = /https:\/\/(?:www\.)?start\.gg\/(tournament\/[^/"]+\/event\/[^/"]+)\/set\/(\d+)/;

function decodeEntities(str) {
  return String(str || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<[^>]*>/g, '')).trim();
}

function eventLinks(html) {
  const paths = new Set();
  for (const m of html.matchAll(/href="\/event\/([^/"]+)\/([^/"]+)"/g)) {
    paths.add(`${m[1]}/${m[2]}`);
  }
  return [...paths].map(p => {
    const [series, event] = p.split('/');
    return { series, event, url: `${BASE_URL}/event/${series}/${event}` };
  });
}

/**
 * Events listed on the home page (ongoing and upcoming), as "series/event" paths.
 */
async function listCurrentEvents() {
  return eventLinks(await getPage('/'));
}

/**
 * Finished events, for a one-off backfill of past restreams.
 */
async function listArchivedEvents() {
  return eventLinks(await getPage('/archive'));
}

/**
 * One row of the races table → { startAt, round, entrants, startggSlug, startggSetId, roomUrl, restreams }
 */
function parseRaceRow(rowHtml) {
  const cells = [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1]);
  if (cells.length < 2) return null;

  const ts = rowHtml.match(/data-timestamp="(\d+)"/);
  const startAt = ts ? new Date(Number(ts[1])) : null;

  const entrants = [...rowHtml.matchAll(/<bdi>([\s\S]*?)<\/bdi>/g)].map(m => stripTags(m[1])).filter(Boolean);

  let startggSlug = null;
  let startggSetId = null;
  let roomUrl = null;
  const restreams = [];
  for (const a of rowHtml.matchAll(/<a\b([^>]*)>/g)) {
    const attrs = a[1];
    const href = decodeEntities((attrs.match(/href="([^"]*)"/) || [])[1] || '');
    const title = decodeEntities((attrs.match(/title="([^"]*)"/) || [])[1] || '');
    const set = href.match(START_GG_SET_RE);
    if (set) {
      startggSlug = set[1];
      startggSetId = set[2];
    } else if (/^https:\/\/racetime\.gg\//.test(href)) {
      roomUrl = href;
    } else if (/restream$/i.test(title) && /^https?:\/\//.test(href)) {
      restreams.push({ language: title.replace(/\s*restream$/i, '').trim(), url: href });
    }
  }

  return {
    startAt,
    round: stripTags(cells[1]) || null,
    entrants,
    startggSlug,
    startggSetId,
    roomUrl,
    restreams
  };
}

function parseTable(html) {
  const races = [];
  for (const tbody of html.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)) {
    for (const row of tbody[1].matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
      const race = parseRaceRow(row[1]);
      if (race) races.push(race);
    }
  }
  return races;
}

/**
 * Races of one event: { upcoming, past }. The page splits them with a "Past races"
 * heading, but a finished event has a single table without it.
 */
async function getEventRaces(series, event) {
  const data = await getPage(`/event/${encodeURIComponent(series)}/${encodeURIComponent(event)}/races`);
  const pastIdx = data.indexOf('<h2>Past races</h2>');
  const upcoming = [];
  const past = pastIdx >= 0 ? parseTable(data.slice(pastIdx)) : [];
  const playedBefore = Date.now() - PLAYED_AFTER_MS;
  for (const race of parseTable(pastIdx >= 0 ? data.slice(0, pastIdx) : data)) {
    if (race.startAt && race.startAt.getTime() < playedBefore) past.push(race);
    else upcoming.push(race);
  }
  return { upcoming, past };
}

module.exports = { BASE_URL, listCurrentEvents, listArchivedEvents, getEventRaces, parseRaceRow };
