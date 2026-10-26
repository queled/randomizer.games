/**
 * YouTube Data API (v3): channels' uploads, to find the restreams archived there
 * once Twitch has deleted the past broadcast, and which videos are still online.
 *
 * Quota: 10,000 units a day; every call here costs 1 unit for up to 50 items, search
 * aside (100 units a call, for the discovery of channels only).
 */

const axios = require('axios');

const API = 'https://www.googleapis.com/youtube/v3';
// Races often start late: a broadcast starting up to this long after the scheduled time still counts
const LATE_START_MS = 45 * 60 * 1000;

function hasKey() {
  return !!process.env.YOUTUBE_API_KEY;
}

async function api(path, params) {
  if (!hasKey()) throw new Error('YOUTUBE_API_KEY manquant');
  const { data } = await axios.get(`${API}${path}`, {
    params: { ...params, key: process.env.YOUTUBE_API_KEY },
    timeout: 20000
  });
  return data;
}

/** "youtube.com/watch?v=<id>", "youtu.be/<id>", "youtube.com/live/<id>" → id */
function videoId(url) {
  const m = String(url || '').match(/^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|live\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}

/** "youtube.com/channel/<id>" → id */
function channelId(url) {
  const m = String(url || '').match(/youtube\.com\/channel\/(UC[\w-]{22})/);
  return m ? m[1] : null;
}

function channelUrl(id) {
  return `https://www.youtube.com/channel/${id}`;
}

/** Videos YouTube still has among `ids` (id → video, with when it was live), 50 per request */
async function getVideos(ids) {
  const videos = new Map();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 50) {
    const data = await api('/videos', { part: 'snippet,liveStreamingDetails,contentDetails', id: unique.slice(i, i + 50).join(','), maxResults: 50 });
    (data.items || []).forEach(v => videos.set(v.id, v));
  }
  return videos;
}

/** Channel id → { title, handle, uploads playlist }, 50 per request */
async function getChannels(ids) {
  const channels = new Map();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 50) {
    const data = await api('/channels', { part: 'snippet,contentDetails', id: unique.slice(i, i + 50).join(','), maxResults: 50 });
    (data.items || []).forEach(c => channels.set(c.id, {
      id: c.id,
      title: c.snippet.title,
      handle: String(c.snippet.customUrl || '').replace(/^@/, ''),
      uploads: c.contentDetails.relatedPlaylists.uploads
    }));
  }
  return channels;
}

/** The channel of a handle ("@name"), null when none */
async function getChannelByHandle(handle) {
  const data = await api('/channels', { part: 'snippet,contentDetails', forHandle: `@${String(handle).replace(/^@/, '')}` });
  const c = (data.items || [])[0];
  return c ? { id: c.id, title: c.snippet.title, handle: String(c.snippet.customUrl || '').replace(/^@/, ''), uploads: c.contentDetails.relatedPlaylists.uploads } : null;
}

/** Videos matching `query` (100 units): [{ videoId, channelId, title }] */
async function searchVideos(query, { after, before } = {}) {
  const data = await api('/search', {
    part: 'snippet', type: 'video', q: query, maxResults: 50,
    publishedAfter: after ? new Date(after).toISOString() : undefined,
    publishedBefore: before ? new Date(before).toISOString() : undefined
  });
  return (data.items || []).map(i => ({ videoId: i.id.videoId, channelId: i.snippet.channelId, title: i.snippet.title }));
}

/**
 * The API refused for lack of quota: nothing more until it resets (midnight, Pacific time).
 * Searches have a daily limit of their own, answered with a 429.
 */
function isQuotaError(error) {
  const reasons = ((error.response && error.response.data && error.response.data.error && error.response.data.error.errors) || []).map(e => e.reason);
  return reasons.includes('quotaExceeded') || reasons.includes('dailyLimitExceeded')
    || (error.response && error.response.status === 429 && reasons.includes('rateLimitExceeded'));
}

/**
 * Uploads of a channel published since `since`, newest first (at most `max`), with when
 * they were live (`liveStreamingDetails`) for past broadcasts.
 */
async function getUploads(channel, since, max = Infinity) {
  const ids = [];
  let pageToken;
  do {
    const data = await api('/playlistItems', { part: 'contentDetails', playlistId: channel.uploads, maxResults: 50, pageToken });
    const items = data.items || [];
    ids.push(...items.filter(i => new Date(i.contentDetails.videoPublishedAt) >= since).map(i => i.contentDetails.videoId));
    // Newest first: stop at the first page reaching past `since`
    if (items.some(i => new Date(i.contentDetails.videoPublishedAt) < since)) break;
    pageToken = data.nextPageToken;
  } while (pageToken && ids.length < max);
  return [...(await getVideos(ids)).values()];
}

function formatOffset(ms) {
  return `${Math.max(0, Math.floor(ms / 1000))}s`;
}

/**
 * Whether a video is the broadcast running when the race started, and the link to that
 * moment; null for an upload (no live times) or a broadcast at another time.
 */
function broadcastAt(video, startAt) {
  const live = video.liveStreamingDetails;
  if (!live || !live.actualStartTime || !live.actualEndTime) return null;
  const start = new Date(startAt).getTime();
  const from = new Date(live.actualStartTime).getTime();
  if (from > start + LATE_START_MS || new Date(live.actualEndTime).getTime() <= start) return null;
  return `https://www.youtube.com/watch?v=${video.id}&t=${formatOffset(start - from)}`;
}

module.exports = { hasKey, videoId, channelId, channelUrl, getVideos, getChannels, getChannelByHandle, searchVideos, isQuotaError, getUploads, broadcastAt };
