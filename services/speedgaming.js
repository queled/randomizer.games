/**
 * speedgaming.org — SpeedGaming restreams tournaments of many games on its own
 * Twitch channels (speedgaming, speedgaming2, speedgaming3...).
 *
 * Its events page pairs each event's bracket (start.gg, Challonge) with its schedule
 * (`speedgaming.org/<slug>`), and its public API gives that schedule: every match
 * restreamed, its players' display names, its start and the channels restreaming it
 * (`/api/schedule/?event=<slug>&from=<ISO>&to=<ISO>`).
 *
 * Only what the restreams need is kept: no crew data.
 */

const axios = require('axios');

const BASE_URL = 'https://speedgaming.org';
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
async function get(path, params) {
  const wait = lastRequestAt + REQUEST_DELAY_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
  const { data } = await http.get(path, { params });
  return data;
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/** Events listed on speedgaming.org/events: [{ title, slug, brackets: [url] }], those with a schedule */
async function getEvents() {
  const html = await get('/events/');
  const events = [];
  for (const block of String(html).matchAll(/<p>([\s\S]*?)<\/p>/gi)) {
    const schedule = block[1].match(/<a[^>]+href="https?:\/\/(?:www\.)?speedgaming\.org\/([A-Za-z0-9_-]+)\/?"[^>]*>\s*Schedule\s*<\/a>/i);
    if (!schedule) continue;
    const title = decodeEntities((block[1].match(/<a[^>]*>([\s\S]*?)<\/a>/i) || [])[1] || '').replace(/<[^>]+>/g, '').trim();
    const brackets = [...block[1].matchAll(/<a[^>]+href="([^"]*)"[^>]*>\s*Bracket\/standings\s*<\/a>/gi)]
      .flatMap(a => [...decodeEntities(a[1]).matchAll(/https?:\/\/[^\s"'<>]+/g)].map(m => m[0]));
    events.push({ title, slug: schedule[1].toLowerCase(), brackets });
  }
  return events;
}

/**
 * Matches of an event's schedule between two dates:
 * [{ id, when, players: [name], title, channels: [{ slug, language }] }]
 */
async function getSchedule(slug, from, to) {
  const data = await get('/api/schedule/', { event: slug, from: new Date(from).toISOString(), to: new Date(to).toISOString() });
  if (!Array.isArray(data)) return [];
  return data.filter(e => e.approved !== false).map(e => ({
    id: e.id,
    when: e.when,
    players: [e.match1, e.match2].filter(Boolean).flatMap(m => (m.players || []).map(p => p.displayName)).filter(Boolean),
    title: (e.match1 && e.match1.title) || e.title || '',
    channels: (e.channels || []).filter(c => c.slug).map(c => ({ slug: String(c.slug).toLowerCase(), language: c.language }))
  }));
}

module.exports = { getEvents, getSchedule };
