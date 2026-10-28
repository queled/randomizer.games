const test = require('node:test');
const assert = require('node:assert/strict');
const { settledSeries } = require('../helpers/settled-series');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-06-15T12:00:00Z');
const daysAgo = (days) => new Date(NOW - days * DAY_MS).toISOString();
const race = (days, status = 'finished') => ({ status, startedAt: daysAgo(days), endedAt: status === 'finished' ? daysAgo(days) : null });
const match = (scoresCsv, extra = {}) => ({ state: 'open', player1Id: 1, player2Id: 2, winnerId: null, scoresCsv, ...extra });

test('settled: score reported, races over a while ago', () => {
  const settled = settledSeries(match('0-2'), [race(20), race(19)], NOW);
  assert.equal(settled.winnerId, 2);
  assert.equal(settled.loserId, 1);
  assert.equal(settled.completedAt.toISOString(), daysAgo(19));
});

test('not settled: last race too recent, the series may go on', () => {
  assert.equal(settledSeries(match('2-0'), [race(10), race(3)], NOW), null);
});

test('not settled: a race still running', () => {
  assert.equal(settledSeries(match('1-0'), [race(20), race(19, 'in_progress')], NOW), null);
});

test('not settled: tied, no score, or more points than races', () => {
  assert.equal(settledSeries(match('1-1'), [race(20), race(19)], NOW), null);
  assert.equal(settledSeries(match(''), [race(20)], NOW), null);
  assert.equal(settledSeries(match('3-0'), [race(20), race(19)], NOW), null);
});

test('not settled: no race, or already validated', () => {
  assert.equal(settledSeries(match('2-0'), [], NOW), null);
  assert.equal(settledSeries(match('2-0', { state: 'complete', winnerId: 1 }), [race(20), race(19)], NOW), null);
});
