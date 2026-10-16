/**
 * Games Done Quick tracker (https://tracker.gamesdonequick.com): public API of
 * the marathons, their runs, runners and video links (YouTube VODs, added
 * after the marathon).
 */

const axios = require('axios');

const API = 'https://tracker.gamesdonequick.com/tracker/api/v2';
const REQUEST_DELAY_MS = 300;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Every page of a paginated list
async function getAll(url) {
  const results = [];
  let next = url;
  while (next) {
    await sleep(REQUEST_DELAY_MS);
    const { data } = await axios.get(next, { timeout: 30000, headers: { 'User-Agent': 'RandomizerWebsite/1.0' } });
    results.push(...(data.results || []));
    next = data.next;
  }
  return results;
}

/** Marathons: { id, short, name, datetime } */
async function listEvents() {
  return getAll(`${API}/events/`);
}

/** Runs of a marathon: { id, name, display_name, category, starttime, run_time, runners[], video_links[] } */
async function listRuns(eventId) {
  try {
    return await getAll(`${API}/events/${eventId}/runs/`);
  } catch (error) {
    // Some old marathons have no runs in the tracker
    if (error.response && error.response.status === 404) return [];
    throw error;
  }
}

/** "0:42:10" → seconds */
function parseDuration(str) {
  const parts = String(str || '').split(':').map(Number);
  if (!parts.length || parts.some(n => !Number.isFinite(n))) return null;
  return parts.reduce((total, n) => total * 60 + n, 0);
}

module.exports = { listEvents, listRuns, parseDuration };
