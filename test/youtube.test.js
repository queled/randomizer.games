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

const { raceIndex, matchVideo, matchScheduleUploads } = require('../helpers/youtube-restreams');

const race = (id, start, a, b) => ({ _id: id, startedAt: start, entrants: [{ userName: a }, { userName: b }], tournament: {} });
const RACES = raceIndex([
  race('r1', '2025-03-01T20:00:00Z', 'Alpha', 'Bravo'),
  race('r2', '2025-03-01T21:00:00Z', 'Alpha', 'Bravo'),
  race('r3', '2025-03-08T20:00:00Z', 'Charlie', 'Delta')
]);
const CHANNEL = { title: 'Restream Channel', handle: 'restreamchannel' };

test('an archived broadcast is the restream of every race it covers, at its start', () => {
  const video = { id: 'abcdefghijk', snippet: { title: 'Event: Final - Alpha vs Bravo' },
    liveStreamingDetails: { actualStartTime: '2025-03-01T19:50:00Z', actualEndTime: '2025-03-01T22:30:00Z' } };
  assert.deepEqual(matchVideo(video, RACES, CHANNEL).map(f => [f.race._id, f.vodUrl]), [
    ['r1', 'https://www.youtube.com/watch?v=abcdefghijk&t=600s'],
    ['r2', 'https://www.youtube.com/watch?v=abcdefghijk&t=4200s']
  ]);
});

test('an upload counts when it fits one race only, and never on a player\'s channel', () => {
  const upload = title => ({ id: 'abcdefghijk', snippet: { title, publishedAt: '2025-03-10T12:00:00Z' } });
  assert.deepEqual(matchVideo(upload('Charlie vs Delta'), RACES, CHANNEL).map(f => f.race._id), ['r3']);
  // Two games of the same players: no way to tell which
  assert.deepEqual(matchVideo({ ...upload('Alpha vs Bravo'), snippet: { title: 'Alpha vs Bravo', publishedAt: '2025-03-02T12:00:00Z' } }, RACES, CHANNEL), []);
  assert.deepEqual(matchVideo(upload('Charlie vs Delta'), RACES, { title: 'Charlie', handle: 'charlie' }), []);
});

test('uploads of a schedule go to its races in order, "Game N" to that game of the series', () => {
  const entry = (room, startAt, a, b) => ({ roomUrl: `https://racetime.gg/game/${room}`, startAt, entrants: [a, b], restreams: [{ language: 'English' }] });
  const tournament = {
    name: 'Example Rando Winter 2025 Tournament',
    matches: [{ raceUrls: ['/game/swiss'] }, { raceUrls: ['/game/g1', '/game/g2', '/game/g3'] }],
    midosHouse: { pastRestreams: [
      entry('swiss', '2025-03-01T20:00:00Z', 'Alpha', 'Bravo'),
      entry('g2', '2025-04-02T20:00:00Z', 'Alpha', 'Bravo'),
      entry('g3', '2025-04-03T20:00:00Z', 'Alpha', 'Bravo')
    ] }
  };
  const upload = (id, title, publishedAt, duration) => ({ id, snippet: { title, publishedAt }, contentDetails: { duration } });
  const found = matchScheduleUploads(tournament, [
    upload('v1', 'Alpha vs Bravo. Example 2025 Tournament', '2025-06-01T12:00:00Z', 'PT2H30M10S'),
    // The same video again
    upload('v2', 'Alpha vs Bravo. Example 2025 Tournament', '2025-06-20T12:00:00Z', 'PT2H30M12S'),
    upload('v3', 'Alpha vs Bravo. Example 2025 Tournament Game 3', '2025-07-01T12:00:00Z', 'PT2H10M'),
    upload('v4', 'Alpha vs Bravo. Example 2025 Tournament Game 2', '2025-07-01T12:00:00Z', 'PT2H40M'),
    // Another year, another tournament
    upload('v5', 'Alpha vs Bravo. Example 2024 Tournament', '2025-07-02T12:00:00Z', 'PT2H')
  ], 'English');
  assert.deepEqual(found.map(f => [f.video.id, f.roomUrl.split('/').pop()]).sort(), [['v1', 'swiss'], ['v3', 'g3'], ['v4', 'g2']]);
});
