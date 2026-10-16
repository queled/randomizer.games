/**
 * Twitch VODs of restreams: finds the past broadcast covering a race and
 * links to the moment the race starts in it.
 *
 * Twitch keeps past broadcasts 7 to 60 days depending on the channel, so a
 * VOD has to be looked up within days of the race.
 */

const axios = require('axios');

const HELIX = 'https://api.twitch.tv/helix';
// Races often start late: a broadcast starting up to this long after the scheduled time still counts
const LATE_START_MS = 45 * 60 * 1000;

let appToken = null;

async function getAppToken() {
  if (appToken && appToken.expiresAt > Date.now()) return appToken.value;
  const { TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET } = process.env;
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) return null;
  const { data } = await axios.post('https://id.twitch.tv/oauth2/token', new URLSearchParams({
    client_id: TWITCH_CLIENT_ID,
    client_secret: TWITCH_CLIENT_SECRET,
    grant_type: 'client_credentials'
  }));
  appToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return appToken.value;
}

async function helix(path, params, attempt = 0) {
  const token = await getAppToken();
  if (!token) throw new Error('TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET manquants');
  try {
    const { data } = await axios.get(`${HELIX}${path}`, {
      params,
      headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID, Authorization: `Bearer ${token}` },
      timeout: 20000
    });
    return data;
  } catch (error) {
    // Rate limited (800 requests a minute): wait for the bucket to refill, then retry
    if (error.response && error.response.status === 429 && attempt < 3) {
      const reset = Number(error.response.headers['ratelimit-reset']) * 1000;
      await new Promise(resolve => setTimeout(resolve, Math.min(Math.max((reset || 0) - Date.now(), 1000), 60000)));
      return helix(path, params, attempt + 1);
    }
    throw error;
  }
}

/** "twitch.tv/<login>" → login, null for videos and other sites */
function twitchLogin(url) {
  const m = String(url || '').match(/^https?:\/\/(?:www\.|m\.)?twitch\.tv\/([A-Za-z0-9_]+)\/?(?:[?#].*)?$/);
  return m && m[1].toLowerCase() !== 'videos' ? m[1].toLowerCase() : null;
}

/** YouTube video link */
function isYoutubeVideo(url) {
  return /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch|live\/)|youtu\.be\/)/.test(String(url || ''));
}

/** login → user id, 100 logins per request */
async function getUserIds(logins) {
  const ids = new Map();
  const unique = [...new Set(logins)];
  for (let i = 0; i < unique.length; i += 100) {
    const params = new URLSearchParams();
    unique.slice(i, i + 100).forEach(login => params.append('login', login));
    const { data } = await helix('/users', params);
    (data || []).forEach(u => ids.set(u.login.toLowerCase(), u.id));
  }
  return ids;
}

/** "twitch.tv/videos/<id>?t=…" → id */
function videoId(url) {
  const m = String(url || '').match(/twitch\.tv\/videos\/(\d+)/);
  return m ? m[1] : null;
}

/** Videos Twitch still has among `ids` (id → video), 100 per request */
async function getVideos(ids) {
  const videos = new Map();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 100) {
    const params = new URLSearchParams();
    unique.slice(i, i + 100).forEach(id => params.append('id', id));
    const { data } = await helix('/videos', params);
    (data || []).forEach(v => videos.set(v.id, v));
  }
  return videos;
}

/** The video ids among `ids` that Twitch still has */
async function getExistingVideoIds(ids) {
  return new Set((await getVideos(ids)).keys());
}

/**
 * Highlights and uploads of a channel: unlike past broadcasts, Twitch keeps them.
 * At most `max` of each type, newest first.
 */
async function getKeptVideos(userId, max = 1000) {
  const videos = [];
  for (const type of ['highlight', 'upload']) {
    let cursor;
    let count = 0;
    do {
      const { data, pagination } = await helix('/videos', { user_id: userId, type, first: 100, after: cursor });
      videos.push(...(data || []));
      count += (data || []).length;
      cursor = pagination && pagination.cursor;
    } while (cursor && count < max);
  }
  return videos;
}

/** Past broadcasts still kept by Twitch, newest first */
async function getArchives(userId) {
  const { data } = await helix('/videos', { user_id: userId, type: 'archive', first: 100 });
  return data || [];
}

/** "3h2m10s" → milliseconds */
function parseDuration(str) {
  const m = String(str || '').match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m) return 0;
  return ((Number(m[1] || 0) * 60 + Number(m[2] || 0)) * 60 + Number(m[3] || 0)) * 1000;
}

function formatOffset(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}h${m}m${s}s`;
}

/**
 * The broadcast running when the race started, with a link to that moment.
 */
function findArchive(archives, startAt) {
  const start = new Date(startAt).getTime();
  const candidates = archives.filter(v => {
    const created = new Date(v.created_at).getTime();
    return created <= start + LATE_START_MS && created + parseDuration(v.duration) > start;
  });
  // Prefer the broadcast already live at the scheduled time
  const video = candidates.find(v => new Date(v.created_at).getTime() <= start) || candidates[0];
  if (!video) return null;
  const offset = start - new Date(video.created_at).getTime();
  return { video, url: `https://www.twitch.tv/videos/${video.id}?t=${formatOffset(offset)}` };
}

function findVod(archives, startAt) {
  const found = findArchive(archives, startAt);
  return found ? found.url : null;
}

/** Channels live right now among `logins` (login → stream), 100 per request */
async function getLiveStreams(logins) {
  const streams = new Map();
  const unique = [...new Set(logins)];
  for (let i = 0; i < unique.length; i += 100) {
    const params = new URLSearchParams();
    unique.slice(i, i + 100).forEach(login => params.append('user_login', login));
    params.append('first', '100');
    const { data } = await helix('/streams', params);
    (data || []).forEach(s => streams.set(s.user_login.toLowerCase(), s));
  }
  return streams;
}

module.exports = { twitchLogin, isYoutubeVideo, videoId, getUserIds, getArchives, getVideos, getExistingVideoIds, getKeptVideos, parseDuration, findArchive, findVod, getLiveStreams };
