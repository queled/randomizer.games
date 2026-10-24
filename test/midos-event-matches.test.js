const test = require('node:test');
const assert = require('node:assert/strict');
const { tiebreakGroup, roundOf, seriesWinner, inferWalkovers, orderBracket, pendingRounds } = require('../helpers/midos-event-matches');

const game = (winner, doneAt = 1) => ({ winner, doneAt });
const match = (round, a, b, winner = null, startAt = 0) => ({ phase: 'Top 8', round, sides: [a, b], winner, startAt });
const PHASES = [{ name: 'Top 8', bracketType: 'SINGLE_ELIMINATION' }];

test('round labels: group, Swiss round, elimination rounds by list or by number', () => {
  assert.deepEqual(roundOf({ bracketType: 'ROUND_ROBIN' }, 'B'), { round: 1, group: 'B' });
  assert.deepEqual(roundOf({ bracketType: 'SWISS' }, 'Round 4'), { round: 4, group: null });
  const se = { bracketType: 'SINGLE_ELIMINATION', rounds: ['Quarterfinal', 'Semifinal', 'Final'] };
  assert.deepEqual(roundOf(se, 'Final'), { round: 3, group: null });
  assert.equal(roundOf(se, 'Round of 16'), null);
  const de = { bracketType: 'DOUBLE_ELIMINATION', rounds: { 'Winners Final': 2, 'Losers Final': -2 } };
  assert.deepEqual(roundOf(de, 'Losers Final'), { round: -2, group: null });
});

test('tie-break labels name their group', () => {
  assert.equal(tiebreakGroup('A tie breaker'), 'A');
  assert.equal(tiebreakGroup('1 Tiebreaker'), '1');
  assert.equal(tiebreakGroup('Tiebreak'), null);
});

test('a series is won once the leader can no longer be caught', () => {
  assert.equal(seriesWinner([game('a'), game('b'), game('a')]), 'a');
  assert.equal(seriesWinner([game('a'), game('a'), game(null, null)]), 'a');
  assert.equal(seriesWinner([game('a'), game(null, null), game(null, null)]), null);
  assert.equal(seriesWinner([game('a'), game('b')]), null);
  assert.equal(seriesWinner([game(null)]), null);
});

test('a match without result is won by the only side playing a later round', () => {
  const matches = inferWalkovers([
    match(1, 'a', 'b'), match(1, 'c', 'd', 'c'), match(2, 'a', 'c'),
    match(1, 'e', 'f')
  ], PHASES);
  assert.equal(matches[0].winner, 'a');
  assert.equal(matches[0].walkover, true);
  assert.equal(matches[3].winner, null);
});

test('bracket order: the matches feeding a match sit together, in the order of its sides', () => {
  const ordered = orderBracket([
    match(1, 'a', 'b', 'a', 1), match(1, 'c', 'd', 'c', 2), match(1, 'e', 'f', 'e', 3), match(1, 'g', 'h', 'g', 4),
    match(2, 'e', 'a', 'e', 5), match(2, 'g', 'c', 'g', 6), match(3, 'e', 'g', 'e', 7),
    { ...match(-1, 'b', 'd', 'b', 8) }
  ]);
  assert.deepEqual(ordered.map(m => m.sides.join('')), ['ef', 'ab', 'gh', 'cd', 'ea', 'gc', 'eg', 'bd']);
});

test('rounds not paired yet: placeholders fed by the winners of the round before', () => {
  const side = id => ({ startggEntrantId: id, name: `P${id}` });
  const sf = (a, b, winnerId = null) => ({ round: 2, phase: 'Top 8', player1: side(a), player2: side(b), winnerId });
  const added = pendingRounds([sf('1', '2', 2), sf('3', '4')], 3);
  assert.equal(added.length, 1);
  assert.equal(added[0].round, 3);
  assert.deepEqual([added[0].player1.name, added[0].player2.name], ['P2', 'TBD']);
  assert.deepEqual(pendingRounds([sf('1', '2', 1)], 2), []);
});
