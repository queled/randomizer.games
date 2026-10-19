/**
 * Async site (https://alttprasyncs.com) — async seeds of a community, grouped in series: practice seeds of a tournament, its live
 * qualifiers (the racetime.gg room, then asyncs of the same seed), leagues,
 * weekly series.
 *
 * No API: the pages are read as HTML.
 *   - /series: every series (id, title, description);
 *   - /series/<id>: its seeds (date in Pacific time, mode, description,
 *     racetime.gg room when the seed was raced live, participants);
 *   - /results/<id>: results of one seed, live and async finishers together.
 */

const axios = require('axios');

const BASE_URL = 'https://alttprasyncs.com';
const REQUEST_DELAY_MS = 1000;

const http = axios.create({
  baseURL: BASE_URL,
  timeout: 30000,
  headers: { 'User-Agent': 'RandomizerWebsite/1.0' }
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let lastRequestAt = 0;
async function getPage(path) {
  const wait = lastRequestAt + REQUEST_DELAY_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
  return String((await http.get(path)).data);
}

function decodeEntities(str) {
  return String(str || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Cells of a table row; some cells are not closed ("<td>26<td>")
function cellsOf(rowHtml) {
  return [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)(?=<td\b|<\/tr>|$)/g)].map(m => m[1].replace(/<\/td>\s*$/, ''));
}

function hrefOf(html) {
  const m = String(html || '').match(/href="([^"]+)"/);
  return m ? decodeEntities(m[1]) : null;
}

// "2025-09-29 16:46:29", Pacific time → Date
function fromPacific(str) {
  const m = String(str || '').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  // Offset of Los Angeles at that moment (-7 h or -8 h)
  const zoned = new Date(new Date(asUtc).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const utc = new Date(new Date(asUtc).toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(asUtc + (utc - zoned));
}

// "1:23:39" → seconds
function parseTime(str) {
  const m = String(str || '').match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  return m ? (Number(m[1] || 0) * 60 + Number(m[2])) * 60 + Number(m[3]) : null;
}

const seriesUrl = id => `${BASE_URL}/series/${id}`;
const resultsUrl = id => `${BASE_URL}/results/${id}`;

/** Every series: [{ id, title, description, url }], newest first */
async function listSeries() {
  const html = await getPage('/series');
  const series = [];
  const re = /href="https:\/\/alttprasyncs\.com\/series\/(\d+)">([\s\S]*?)<\/a><\/div><br \/><div class="displaySeriesDesc">([\s\S]*?)<\/div>/g;
  for (const m of html.matchAll(re)) {
    series.push({ id: Number(m[1]), title: stripTags(m[2]), description: stripTags(m[3]), url: seriesUrl(m[1]) });
  }
  return series;
}

/** Seeds of a series: [{ asyncId, createdAt, mode, description, roomUrl, participants, resultsUrl }] */
async function getSeriesSeeds(seriesId) {
  const html = await getPage(`/series/${encodeURIComponent(seriesId)}`);
  const seeds = [];
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = cellsOf(row[1]);
    if (cells.length < 9) continue;
    const results = hrefOf(cells[8]) || '';
    const asyncId = Number((results.match(/\/results\/(\d+)/) || [])[1]);
    if (!asyncId) continue;
    const room = hrefOf(cells[3]);
    seeds.push({
      asyncId,
      createdAt: fromPacific(stripTags(cells[0])),
      mode: stripTags(cells[1]) || null,
      description: stripTags(cells[2]) || null,
      // A seed raced live links its room; practice seeds only name one
      roomUrl: room && /^https:\/\/racetime\.gg\//.test(room) ? room : null,
      participants: parseInt(stripTags(cells[6]), 10) || 0,
      resultsUrl: resultsUrl(asyncId)
    });
  }
  return seeds;
}

/** Results of a seed: { participants, finishers, results: [{ place, name, time, forfeit, vodUrl }] } */
async function getResults(asyncId) {
  const html = await getPage(`/results/${encodeURIComponent(asyncId)}`);
  const counts = html.match(/Participants:\s*(\d+)\s*-\s*Finishers:\s*(\d+)/);
  const results = [];
  const table = html.slice(html.indexOf('class="raceResults"'));
  for (const row of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = cellsOf(row[1]);
    if (cells.length < 3) continue;
    // The name cell also holds the player's comment, in a tooltip
    const name = stripTags(cells[1].replace(/<span class="comment"[\s\S]*?<\/span>/g, ''));
    if (!name) continue;
    const forfeit = /^ff$/i.test(stripTags(cells[0]));
    const vod = hrefOf(cells[4] || '');
    results.push({
      place: forfeit ? null : parseInt(stripTags(cells[0]), 10) || null,
      name,
      time: forfeit ? null : parseTime(stripTags(cells[2])),
      forfeit,
      vodUrl: vod && /^https?:\/\//.test(vod) ? vod : null
    });
  }
  return {
    participants: counts ? Number(counts[1]) : results.length,
    finishers: counts ? Number(counts[2]) : results.filter(r => !r.forfeit).length,
    results
  };
}

module.exports = { BASE_URL, seriesUrl, resultsUrl, listSeries, getSeriesSeeds, getResults, fromPacific, parseTime };
