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

// Pools: a, b, c, d won theirs; e, f, g, h lost. Gold (a-d) is declared after Silver (e-h).
const POOL_SETS = [
  set('Pools', 1, 'a', 'e', 'a'), set('Pools', 1, 'b', 'f', 'b'),
  set('Pools', 1, 'c', 'g', 'c'), set('Pools', 1, 'd', 'h', 'd')
];
const bracketSets = (gold, silver) => [
  set(silver, 1, 'e', 'f', 'e'), set(silver, 1, 'g', 'h', 'g'), set(silver, 2, 'e', 'g', 'e'),
  set(gold, 1, 'a', 'b', 'a'), set(gold, 1, 'c', 'd', 'c')
];
const parallelPhases = (gold, silver) => [
  { name: 'Pools', bracketType: 'ROUND_ROBIN', phaseOrder: 1 },
  { name: silver, bracketType: 'SINGLE_ELIMINATION', phaseOrder: 2 },
  { name: gold, bracketType: 'SINGLE_ELIMINATION', phaseOrder: 3 }
];

test('parallel brackets: the last of the stronger one above the winner of the other', () => {
  const ranks = computeProvisionalRanks([...POOL_SETS, ...bracketSets('Bracket A', 'Bracket B')],
    parallelPhases('Bracket A', 'Bracket B'));
  assert.deepEqual(ranksOf(ranks), { a: 1, c: 1, b: 3, d: 3, e: 5, g: 6, f: 7, h: 7 });
});

// Even pools: a and f won, so neither bracket's players won more
const EVEN_POOLS = [set('Pools', 1, 'a', 'e', 'a'), set('Pools', 1, 'f', 'b', 'f')];
const evenBrackets = (first, second) => [
  ...EVEN_POOLS, set(first, 1, 'a', 'b', 'a'), set(second, 1, 'e', 'f', 'e')
];

test('parallel brackets: their names tell the stronger one', () => {
  const phases = [
    { name: 'Pools', bracketType: 'ROUND_ROBIN', phaseOrder: 1 },
    { name: 'Gold', bracketType: 'SINGLE_ELIMINATION', phaseOrder: 2 },
    { name: 'Silver', bracketType: 'SINGLE_ELIMINATION', phaseOrder: 3 }
  ];
  const ranks = computeProvisionalRanks(evenBrackets('Gold', 'Silver'), phases);
  assert.deepEqual(ranksOf(ranks), { a: 1, b: 2, e: 3, f: 4 });
});

test('parallel brackets of unknown order share a tier', () => {
  const ranks = computeProvisionalRanks(evenBrackets('Bracket A', 'Bracket B'), parallelPhases('Bracket A', 'Bracket B'));
  // Ranked together: those still in by their earlier record, the knocked-out ones tied
  assert.deepEqual(ranksOf(ranks), { a: 1, e: 2, b: 3, f: 3 });
});

test('Swiss: equal records told apart by the wins of the opponents met', () => {
  const ranks = computeProvisionalRanks([
    set('Swiss', 1, 'a', 'b', 'a'), set('Swiss', 1, 'c', 'e', 'c'), set('Swiss', 1, 'f', 'd'),
    set('Swiss', 2, 'b', 'd', 'b'), set('Swiss', 2, 'f', 'c', 'f'), set('Swiss', 2, 'e', 'd', 'e')
  ], [{ name: 'Swiss', bracketType: 'SWISS', phaseOrder: 1 }]);
  // At 1-1, c met e and f (one win each), b and e met opponents with one win in all
  assert.deepEqual(ranksOf(ranks), { a: 1, f: 1, c: 3, b: 4, e: 4, d: 6 });
});
