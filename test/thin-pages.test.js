const test = require('node:test');
const assert = require('node:assert/strict');
const { isThinGame, isThinPlayer } = require('../helpers/thin-pages');

test('a game with a history or any activity is worth indexing', () => {
  assert.equal(isThinGame({ totalRaces: 0, totalTournaments: 0, hasHistory: false }), true);
  assert.equal(isThinGame({ totalRaces: 0, totalTournaments: 0, hasHistory: true }), false);
  assert.equal(isThinGame({ totalRaces: 1, totalTournaments: 0, hasHistory: false }), false);
  assert.equal(isThinGame({ totalRaces: 0, totalTournaments: 1, hasHistory: false }), false);
});

test('a player needs three races or a tournament', () => {
  assert.equal(isThinPlayer({ races: 2, tournaments: 0 }), true);
  assert.equal(isThinPlayer({ races: 3, tournaments: 0 }), false);
  assert.equal(isThinPlayer({ races: 0, tournaments: 1 }), false);
  assert.equal(isThinPlayer({}), true);
});
