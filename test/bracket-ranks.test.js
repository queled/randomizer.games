const test = require('node:test');
const assert = require('node:assert/strict');
const { computeEliminationRanks, fillMissingFinalRanks } = require('../helpers/bracket-ranks');

const match = (round, winnerId, loserId, extra = {}) => ({ round, winnerId, loserId, state: 'complete', ...extra });

const ranksOf = (ranks) => Object.fromEntries(ranks);

test('single elimination: semi-final losers tie for third', () => {
  const ranks = computeEliminationRanks({
    tournamentType: 'single elimination',
    matches: [match(1, 1, 2), match(1, 3, 4), match(2, 1, 3)]
  });
  assert.deepEqual(ranksOf(ranks), { 1: 1, 3: 2, 2: 3, 4: 3 });
});

test('single elimination: a third place match splits the semi-final losers', () => {
  const ranks = computeEliminationRanks({
    tournamentType: 'single_elimination',
    matches: [match(1, 1, 2), match(1, 3, 4), match(2, 1, 3), match(2, 2, 4)]
  });
  assert.deepEqual(ranksOf(ranks), { 1: 1, 3: 2, 2: 3, 4: 4 });
});

test('double elimination: ranked by losers bracket stage, unplayed reset ignored', () => {
  const ranks = computeEliminationRanks({
    tournamentType: 'double elimination',
    matches: [
      match(1, 1, 2), match(1, 3, 4),
      match(2, 1, 3),
      match(-1, 2, 4),
      match(-2, 3, 2),
      match(3, 1, 3),
      { round: 4, state: 'open', winnerId: null, loserId: null }
    ]
  });
  assert.deepEqual(ranksOf(ranks), { 1: 1, 3: 2, 2: 3, 4: 4 });
});

test('double elimination: a played reset decides the champion', () => {
  const ranks = computeEliminationRanks({
    tournamentType: 'double elimination',
    matches: [
      match(1, 1, 2), match(1, 3, 4),
      match(2, 1, 3),
      match(-1, 2, 4),
      match(-2, 3, 2),
      match(3, 3, 1, { completedAt: '2026-01-01T10:00:00Z' }),
      match(4, 3, 1, { completedAt: '2026-01-01T11:00:00Z' })
    ]
  });
  assert.deepEqual(ranksOf(ranks), { 3: 1, 1: 2, 2: 3, 4: 4 });
});

test('no ranks for an unfinished bracket, a round robin or group matches only', () => {
  assert.equal(computeEliminationRanks({
    tournamentType: 'single elimination',
    matches: [match(1, 1, 2), { round: 2, state: 'open' }]
  }), null);
  assert.equal(computeEliminationRanks({ tournamentType: 'round robin', matches: [match(1, 1, 2)] }), null);
  assert.equal(computeEliminationRanks({
    tournamentType: 'single elimination',
    matches: [match(1, 1, 2, { groupId: 7 })]
  }), null);
});

test('fillMissingFinalRanks only fills a finished bracket without ranks', () => {
  const matches = [match(1, 1, 2), match(1, 3, 4), match(2, 1, 3)];
  const participants = () => [1, 2, 3, 4].map((challongeId) => ({ challongeId, finalRank: null }));

  const filled = fillMissingFinalRanks({
    tournamentData: { state: 'awaiting_review', tournamentType: 'single elimination' },
    participants: participants(),
    matches
  });
  assert.deepEqual(filled.map((p) => p.finalRank), [1, 3, 2, 3]);

  const running = fillMissingFinalRanks({
    tournamentData: { state: 'underway', tournamentType: 'single elimination' },
    participants: participants(),
    matches
  });
  assert.deepEqual(running.map((p) => p.finalRank), [null, null, null, null]);

  const known = participants();
  known[0].finalRank = 2;
  fillMissingFinalRanks({ tournamentData: { state: 'complete', tournamentType: 'single elimination' }, participants: known, matches });
  assert.deepEqual(known.map((p) => p.finalRank), [2, null, null, null]);
});
