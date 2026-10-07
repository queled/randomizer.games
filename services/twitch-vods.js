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

async function helix(path, params) {
  const token = await getAppToken();
  if (!token) throw new Error('TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET manquants');
  const { data } = await axios.get(`${HELIX}${path}`, {
    params,
    headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID, Authorization: `Bearer ${token}` },
    timeout: 20000
  });
  return data;
}

/** "twitch.tv/<login>" → login, null for other sites */
function twitchLogin(url) {
  const m = String(url || '').match(/^https?:\/\/(?:www\.|m\.)?twitch\.tv\/([A-Za-z0-9_]+)\/?$/);
  return m ? m[1].toLowerCase() : null;
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
 * The broadcast running when the race started, as a link to that moment.
 */
function findVod(archives, startAt) {
  const start = new Date(startAt).getTime();
  const candidates = archives.filter(v => {
    const created = new Date(v.created_at).getTime();
    return created <= start + LATE_START_MS && created + parseDuration(v.duration) > start;
  });
  // Prefer the broadcast already live at the scheduled time
  const vod = candidates.find(v => new Date(v.created_at).getTime() <= start) || candidates[0];
  if (!vod) return null;
  const offset = start - new Date(vod.created_at).getTime();
  return `https://www.twitch.tv/videos/${vod.id}?t=${formatOffset(offset)}`;
}

module.exports = { twitchLogin, getUserIds, getArchives, findVod };
