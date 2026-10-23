const test = require('node:test');
const assert = require('node:assert/strict');
const { computeProvisionalRanks } = require('../helpers/provisional-ranks');

const set = (phase, round, p1, p2, winnerId = null) => ({
  phase, round, winnerId, player1: { startggEntrantId: p1 }, player2: { startggEntrantId: p2 }
});

const ranksOf = (ranks) => Object.fromEntries(ranks);

const PHASES = [
  { name: 'Pools', bracketType: 'ROUND_ROBIN', phaseOrder: 1 },
  { name: 'Top 4', bracketType: 'SINGLE_ELIMINATION', phaseOrder: 2 }
];

test('pools under way: more wins first, then fewer losses, ties shared', () => {
  const ranks = computeProvisionalRanks([
    set('Pools', 1, 'a', 'b', 'a'), set('Pools', 1, 'c', 'd', 'c'),
    set('Pools', 2, 'a', 'c', 'a'), set('Pools', 2, 'b', 'd', 'b'),
    set('Pools', 3, 'a', 'd'), set('Pools', 3, 'b', 'c')
  ], PHASES);
  assert.deepEqual(ranksOf(ranks), { a: 1, b: 2, c: 2, d: 4 });
});

test('the next phase ranks above the pools, those still in by their pool record', () => {
  const ranks = computeProvisionalRanks([
    set('Pools', 1, 'a', 'b', 'a'), set('Pools', 1, 'c', 'd', 'c'), set('Pools', 1, 'e', 'f', 'e'),
    set('Pools', 2, 'a', 'c', 'a'), set('Pools', 2, 'b', 'd', 'd'),
    set('Top 4', 1, 'a', 'c'), set('Top 4', 1, 'e', null)
  ], PHASES);
  assert.deepEqual(ranksOf(ranks), { a: 1, e: 2, c: 3, d: 4, f: 5, b: 6 });
});

test('single elimination: the knocked-out entrants by the round they fell in', () => {
  const ranks = computeProvisionalRanks([
    set('Top 4', 1, 'a', 'b', 'a'), set('Top 4', 1, 'c', 'd', 'c'), set('Top 4', 2, 'a', 'c', 'c')
  ], PHASES);
  assert.deepEqual(ranksOf(ranks), { c: 1, a: 2, b: 3, d: 3 });
});

test('double elimination: one loss still in, out on the second loss', () => {
  const ranks = computeProvisionalRanks([
    set('Bracket', 1, 'a', 'b', 'a'), set('Bracket', 1, 'c', 'd', 'c'),
    set('Bracket', 2, 'a', 'c', 'a'),
    set('Bracket', -1, 'b', 'd', 'b'),
    set('Bracket', -2, 'c', 'b', 'c')
  ], [{ name: 'Bracket', bracketType: 'DOUBLE_ELIMINATION', phaseOrder: 1 }]);
  assert.deepEqual(ranksOf(ranks), { a: 1, c: 2, b: 3, d: 4 });
});
