/**
 * Async sites (https://alttprasyncs.com, and https://www.smz3asyncs.com which runs the same software) — async seeds of a community, grouped in series: practice seeds of a tournament, its live
 * qualifiers (the racetime.gg room, then asyncs of the same seed), leagues,
 * weekly series.
 *
 * No API: the pages are read as HTML.
 *   - /series: every series (id, title, description);
 *   - /series/<id>: its seeds (date in Pacific time, mode, description,
 *     racetime.gg room when the seed was raced live, participants);
 *   - /results/<id>: results of one seed, live and async finishers together.
 * Every function reads alttprasyncs.com unless given the base URL of another site.
 */

const axios = require('axios');

const BASE_URL = 'https://alttprasyncs.com';
const SMZ3_URL = 'https://www.smz3asyncs.com';
const REQUEST_DELAY_MS = 1000;

const http = axios.create({
  timeout: 30000,
  headers: { 'User-Agent': 'RandomizerWebsite/1.0' }
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let lastRequestAt = 0;
async function getPage(path, base = BASE_URL) {
  const wait = lastRequestAt + REQUEST_DELAY_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
  return String((await http.get(`${base}${path}`)).data);
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

// "2025-09-29 16:46:29", Pacific time (or UTC) → Date
function fromPacific(str, inUtc = false) {
  const m = String(str || '').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (inUtc) return new Date(asUtc);
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

const seriesUrl = (id, base = BASE_URL) => `${base}/series/${id}`;
const resultsUrl = (id, base = BASE_URL) => `${base}/results/${id}`;

/** Every series: [{ id, title, description, url }], newest first */
async function listSeries(base = BASE_URL) {
  const html = await getPage('/series', base);
  const series = [];
  // The last description of the page is not closed by a </div>
  const re = /href="https?:\/\/[^"/]+\/series\/(\d+)">([\s\S]*?)<\/a><\/div><br \/><div class="displaySeriesDesc">([\s\S]*?)<\/(?:div|td)>/g;
  for (const m of html.matchAll(re)) {
    series.push({ id: Number(m[1]), title: stripTags(m[2]), description: stripTags(m[3]), url: seriesUrl(m[1], base) });
  }
  return series;
}

/** Seeds of a series: [{ asyncId, createdAt, mode, description, roomUrl, participants, resultsUrl }] */
async function getSeriesSeeds(seriesId, base = BASE_URL) {
  const html = await getPage(`/series/${encodeURIComponent(seriesId)}`, base);
  // "Date (PST)" on alttprasyncs.com, "Date (UTC)" on smz3asyncs.com
  const utc = /<th>Date \(UTC\)<\/th>/i.test(html);
  const seeds = [];
  // smz3asyncs.com draws the hash as a table within the row
  const rows = html.replace(/<table class="hash">[\s\S]*?<\/table>/g, '');
  for (const row of rows.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = cellsOf(row[1]);
    if (cells.length < 9) continue;
    const results = hrefOf(cells[8]) || '';
    const asyncId = Number((results.match(/\/results\/(\d+)/) || [])[1]);
    if (!asyncId) continue;
    const room = hrefOf(cells[3]);
    seeds.push({
      asyncId,
      createdAt: fromPacific(stripTags(cells[0]), utc),
      mode: stripTags(cells[1]) || null,
      description: stripTags(cells[2]) || null,
      // A seed raced live links its room; practice seeds only name one
      roomUrl: room && /^https:\/\/racetime\.gg\//.test(room) ? room : null,
      participants: parseInt(stripTags(cells[6]), 10) || 0,
      resultsUrl: resultsUrl(asyncId, base)
    });
  }
  return seeds;
}

/** A seed outside any series (a qualifier), from its submit page: { mode, description } */
async function getAsync(asyncId, base = BASE_URL) {
  const html = await getPage(`/async/${encodeURIComponent(asyncId)}`, base);
  const m = html.match(/Mode:\s*([^<]*)<br \/>([\s\S]*?)<br \/>/);
  return { mode: m ? stripTags(m[1]) || null : null, description: m ? stripTags(m[2]) || null : null };
}

/** Results of a seed: { participants, finishers, results: [{ place, name, time, forfeit, vodUrl }] } */
async function getResults(asyncId, base = BASE_URL) {
  const html = await getPage(`/results/${encodeURIComponent(asyncId)}`, base);
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

module.exports = { BASE_URL, SMZ3_URL, seriesUrl, resultsUrl, listSeries, getSeriesSeeds, getAsync, getResults, fromPacific, parseTime };
