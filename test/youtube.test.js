const test = require('node:test');
const assert = require('node:assert/strict');
const { videoId, channelId, broadcastAt } = require('../services/youtube');

test('video and channel ids from YouTube links', () => {
  assert.equal(videoId('https://www.youtube.com/watch?v=abcdefghijk&t=10s'), 'abcdefghijk');
  assert.equal(videoId('https://youtu.be/abcdefghijk'), 'abcdefghijk');
  assert.equal(videoId('https://www.youtube.com/live/abcdefghijk'), 'abcdefghijk');
  assert.equal(videoId('https://www.twitch.tv/videos/123'), null);
  assert.equal(channelId('https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv'), 'UCabcdefghijklmnopqrstuv');
});

test('a broadcast covering the race start links to that moment', () => {
  const video = { id: 'abcdefghijk', liveStreamingDetails: { actualStartTime: '2025-01-01T20:00:00Z', actualEndTime: '2025-01-01T23:00:00Z' } };
  assert.equal(broadcastAt(video, '2025-01-01T20:10:00Z'), 'https://www.youtube.com/watch?v=abcdefghijk&t=600s');
  // Started late, after the scheduled time
  assert.equal(broadcastAt(video, '2025-01-01T19:30:00Z'), 'https://www.youtube.com/watch?v=abcdefghijk&t=0s');
  assert.equal(broadcastAt(video, '2025-01-01T23:30:00Z'), null);
  assert.equal(broadcastAt({ id: 'abcdefghijk' }, '2025-01-01T20:10:00Z'), null);
});
