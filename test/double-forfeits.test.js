const test = require('node:test');
const assert = require('node:assert/strict');
const { markDoubleForfeits, isUnfinished } = require('../helpers/double-forfeits');
const { computeProvisionalRanks } = require('../helpers/provisional-ranks');

const PHASES = [{ name: 'Top 8', bracketType: 'SINGLE_ELIMINATION', phaseOrder: 1 }];

const set = (round, p1, p2, winnerId, raceUrl = null) => ({
  phase: 'Top 8', round, state: 3, winnerId, raceUrl,
  player1: { startggEntrantId: p1 }, player2: { startggEntrantId: p2 }
});

test('a room nobody finished: cancelled, or over with everyone out', () => {
  assert.equal(isUnfinished({ status: 'cancelled', entrants: [] }), true);
  assert.equal(isUnfinished({ status: 'finished', entrants: [{ status: 'dnf' }, { status: 'dnf' }] }), true);
  assert.equal(isUnfinished({ status: 'finished', entrants: [{ status: 'done' }, { status: 'dnf' }] }), false);
  assert.equal(isUnfinished({ status: 'in_progress', entrants: [] }), false);
});

test('both out in the first set, the next one lost without a room: a double forfeit', () => {
  const matches = [
    set(1, '1', '2', 1, '/ootr/first-room'), set(1, '3', '4', 3, '/ootr/second-room'),
    set(2, '3', '1', 3), set(2, '5', '6', null)
  ];
  assert.equal(markDoubleForfeits(matches, PHASES, new Set(['ootr/first-room'])), 1);
  assert.equal(matches[0].doubleForfeit, true);
  assert.equal(matches[2].withdrawnEntrantId, '1');
  assert.equal(matches[1].doubleForfeit, undefined);
});

test('not a double forfeit: the next set has its room, or the room was finished', () => {
  const played = [set(1, '1', '2', 1, '/ootr/first-room'), set(2, '3', '1', 3, '/ootr/next-room')];
  assert.equal(markDoubleForfeits(played, PHASES, new Set(['ootr/first-room'])), 0);
  const finished = [set(1, '1', '2', 1, '/ootr/first-room'), set(2, '3', '1', 3)];
  assert.equal(markDoubleForfeits(finished, PHASES, new Set()), 0);
});

test('ranks: both players out at the double forfeit, the next set no win', () => {
  const matches = [
    set(1, '1', '2', 1, '/ootr/first-room'), set(1, '3', '4', 3, '/ootr/second-room'),
    set(2, '3', '1', 3)
  ];
  markDoubleForfeits(matches, PHASES, new Set(['ootr/first-room']));
  assert.deepEqual(Object.fromEntries(computeProvisionalRanks(matches, PHASES)), { 3: 1, 1: 2, 2: 2, 4: 2 });
});
