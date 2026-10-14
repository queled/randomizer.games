// racetime.gg profile of a player (avatar, Twitch channel), read from the JSON
// API (/user/<id>/data) instead of the profile HTML.
//
// The avatar URL is kept on the Player document and read again after
// PROFILE_TTL_MS, so an avatar changed on racetime shows up within hours. When
// the stored avatar no longer loads (replaced by a file of another name), the
// profile is read again at once.

const axios = require('axios');
const { Player } = require('../models');
const { isSafeImageContentType, setRelayedImageHeaders } = require('../middleware/security');

const RACETIME_HOST = 'racetime.gg';
const PROFILE_TTL_MS = 6 * 60 * 60 * 1000;
// A forced refresh (avatar that no longer loads) at most this often per account
const MIN_REFRESH_MS = 5 * 60 * 1000;
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
// Accounts without a Player document (raced, never imported): kept in memory
const MEMORY_MAX_ENTRIES = 2000;
// racetime user ids are 16 letters and digits
const USER_ID_PATTERN = /^[A-Za-z0-9]{8,32}$/;
const TWITCH_LOGIN_PATTERN = /^[A-Za-z0-9_]{1,25}$/;

const memoryProfiles = new Map();
const inFlight = new Map();

function isAllowedRacetimeHost(hostname) {
  const normalized = String(hostname || '').toLowerCase();
  return normalized === RACETIME_HOST || normalized.endsWith('.' + RACETIME_HOST);
}

/** Absolute https URL on racetime.gg, or null. */
function normalizeRacetimeMediaUrl(urlOrPath) {
  const raw = String(urlOrPath || '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw, `https://${RACETIME_HOST}`);
    if (!['http:', 'https:'].includes(parsed.protocol) || !isAllowedRacetimeHost(parsed.hostname)) return null;
    if (parsed.username || parsed.password || parsed.port) return null;
    return `https://${parsed.hostname.toLowerCase()}${parsed.pathname}${parsed.search}`;
  } catch (e) {
    return null;
  }
}

/** racetime user id from an id, a profile URL or a /user/<id>/... path, or null. */
function racetimeUserIdFrom(value) {
  const raw = String(value || '').trim();
  if (USER_ID_PATTERN.test(raw)) return raw;
  const match = raw.match(/(?:^|racetime\.gg)\/?user\/([A-Za-z0-9]+)/i);
  return match && USER_ID_PATTERN.test(match[1]) ? match[1] : null;
}

/** The profile JSON, null when racetime does not know the account. Throws on other errors. */
async function fetchRacetimeUserData(userId) {
  try {
    const response = await axios.get(`https://${RACETIME_HOST}/user/${encodeURIComponent(userId)}/data`, {
      timeout: 8000,
      maxRedirects: 0,
      maxContentLength: 1024 * 1024,
      headers: { 'User-Agent': 'RandomizerWebsite/1.0', Accept: 'application/json' }
    });
    return response.data && typeof response.data === 'object' ? response.data : null;
  } catch (error) {
    if (error.response?.status === 404) return null;
    throw error;
  }
}

/** { avatarUrl, twitch } from the profile JSON (null fields when absent). */
function profileFromUserData(data) {
  const twitch = String(data?.twitch_name || '').trim().toLowerCase();
  return {
    avatarUrl: normalizeRacetimeMediaUrl(data?.avatar),
    twitch: TWITCH_LOGIN_PATTERN.test(twitch) ? twitch : null
  };
}

function rememberProfile(userId, entry) {
  if (!memoryProfiles.has(userId) && memoryProfiles.size >= MEMORY_MAX_ENTRIES) {
    memoryProfiles.delete(memoryProfiles.keys().next().value);
  }
  memoryProfiles.set(userId, entry);
}

async function readAndStoreProfile(userId, player) {
  let data;
  try {
    data = await fetchRacetimeUserData(userId);
  } catch (error) {
    // racetime unreachable: keep what is known
    if (player) return { avatarUrl: player.avatarUrl || null, twitch: player.twitch || null };
    return memoryProfiles.get(userId)?.profile || null;
  }

  const profile = profileFromUserData(data);
  const checkedAt = new Date();
  if (player) {
    const set = { avatarUrl: profile.avatarUrl, avatarCheckedAt: checkedAt };
    // A Twitch channel entered by hand is kept
    if (profile.twitch && !player.twitch) set.twitch = profile.twitch;
    await Player.updateOne({ _id: player._id }, { $set: set });
    return { avatarUrl: profile.avatarUrl, twitch: player.twitch || profile.twitch };
  }
  rememberProfile(userId, { profile, checkedAt: checkedAt.getTime() });
  return profile;
}

/**
 * { avatarUrl, twitch } of a racetime account, or null for an invalid id.
 * `force` reads racetime again even if the stored profile is recent (but not
 * more than once per MIN_REFRESH_MS).
 */
async function getRacetimeProfile(userId, { force = false } = {}) {
  if (!USER_ID_PATTERN.test(String(userId || ''))) return null;

  const player = await Player.findOne({ userId }).select('avatarUrl avatarCheckedAt twitch').lean();
  const remembered = player ? null : memoryProfiles.get(userId);
  const checkedAt = player ? (player.avatarCheckedAt ? player.avatarCheckedAt.getTime() : 0) : (remembered?.checkedAt || 0);
  const age = Date.now() - checkedAt;
  if (age < (force ? MIN_REFRESH_MS : PROFILE_TTL_MS)) {
    return player ? { avatarUrl: player.avatarUrl || null, twitch: player.twitch || null } : remembered.profile;
  }

  if (!inFlight.has(userId)) {
    inFlight.set(userId, readAndStoreProfile(userId, player).finally(() => inFlight.delete(userId)));
  }
  return inFlight.get(userId);
}

/**
 * Stream an image hosted on racetime.gg to the client.
 * The URL must stay on racetime.gg (redirects included) and the upstream
 * answer must be a raster image: HTML or SVG are never relayed on our origin.
 * Returns true when the response was sent, false so the caller can try
 * something else.
 */
async function relayRacetimeImage(rawUrl, res, { cacheControl } = {}) {
  const safeUrl = normalizeRacetimeMediaUrl(rawUrl);
  if (!safeUrl) return false;

  let upstream;
  try {
    upstream = await axios.get(safeUrl, {
      responseType: 'stream',
      timeout: 10000,
      maxRedirects: 3,
      beforeRedirect: (options) => {
        if (!isAllowedRacetimeHost(options.hostname)) {
          throw new Error('Redirect outside racetime.gg');
        }
      }
    });
  } catch (e) {
    return false;
  }

  const contentType = upstream.headers['content-type'];
  const declaredLength = Number(upstream.headers['content-length']);
  if (!isSafeImageContentType(contentType) || (Number.isFinite(declaredLength) && declaredLength > MAX_AVATAR_BYTES)) {
    upstream.data.destroy();
    return false;
  }

  setRelayedImageHeaders(res);
  res.setHeader('Content-Type', String(contentType).split(';')[0].trim());
  res.setHeader('Cache-Control', cacheControl || upstream.headers['cache-control'] || 'public, max-age=3600');

  let received = 0;
  upstream.data.on('data', (chunk) => {
    received += chunk.length;
    if (received > MAX_AVATAR_BYTES) {
      upstream.data.destroy();
      res.destroy();
    }
  });
  upstream.data.on('error', () => res.destroy());
  upstream.data.pipe(res);
  return true;
}

module.exports = {
  getRacetimeProfile,
  fetchRacetimeUserData,
  profileFromUserData,
  racetimeUserIdFrom,
  relayRacetimeImage,
  TWITCH_LOGIN_PATTERN
};
