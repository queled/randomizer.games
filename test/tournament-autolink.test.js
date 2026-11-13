const test = require('node:test');
const assert = require('node:assert/strict');
const {
  goalTokens,
  collectCandidateCategories,
  getRaceLabelBracketSide,
  getExpectedStartggRaceCount,
  hasAvailableStartggSlot
} = require('../services/tournament-autolink');

test('goal tokens: "Season 3", "Saison 3" and "S3" name the same edition', () => {
  assert.deepEqual(goalTokens('Fancy Cup Season 3'), ['fancy', 'cup', 's3']);
  assert.deepEqual(goalTokens('Fancy Cup Saison 3'), ['fancy', 'cup', 's3']);
  assert.deepEqual(goalTokens('Fancy Cup S3'), ['fancy', 'cup', 's3']);
});

test('goal tokens: an edition year reads the same glued, spaced or shortened', () => {
  assert.ok(goalTokens('EVT2026').includes('evt26'));
  assert.ok(goalTokens('EVT 2026').includes('evt26'));
  assert.ok(goalTokens('EVT26').includes('evt26'));
});

test('goal tokens: generic words, single characters and punctuation are dropped', () => {
  assert.deepEqual(goalTokens('The Standard Ruleset of the Tournament - Round 2 (A vs B)'), []);
  assert.deepEqual(goalTokens('Fancy-Cup: Main Bracket!'), ['fancy', 'cup']);
  assert.deepEqual(goalTokens(''), []);
  assert.deepEqual(goalTokens(null), []);
});

test('candidate categories: those of the attached races, then the racetime slugs of the game', () => {
  const tournament = { game: { integrations: { racetime: { gameSlug: 'main', gameSlugs: ['main', 'extra', ''] } } } };
  assert.deepEqual(collectCandidateCategories(tournament, [{ category: 'other' }, { category: 'main' }, {}]), ['other', 'main', 'extra']);
  assert.deepEqual(collectCandidateCategories({ game: 'an id, not a document' }, [{ category: 'other' }]), ['other']);
  assert.deepEqual(collectCandidateCategories(null), []);
});

test('bracket side: the label names the losers or the winners side', () => {
  const side = (info) => getRaceLabelBracketSide({ info });
  assert.equal(side('Lower Bracket Round 4: Aaa vs Bbb'), 'losers');
  assert.equal(side('Losers Finals - Aaa vs Bbb'), 'losers');
  assert.equal(side('Loser Semi: Aaa vs Bbb'), 'losers');
  assert.equal(side('Upper Bracket Round 2: Aaa vs Bbb'), 'winners');
  assert.equal(side('Winners Final: Aaa vs Bbb'), 'winners');
});

test('bracket side: unknown without the words, and only the first line counts', () => {
  const side = (info) => getRaceLabelBracketSide({ info });
  assert.equal(side('Aaa vs Bbb'), null);
  assert.equal(side('Round 4: Aaa vs Bbb'), null);
  assert.equal(side('Lowerbound vs Winnerman'), null);
  assert.equal(side('Aaa vs Bbb\nLower Bracket Round 4'), null);
  assert.equal(getRaceLabelBracketSide({}), null);
});

test('expected races of a match: the games of the series score', () => {
  assert.equal(getExpectedStartggRaceCount({ displayScore: 'Aaa 2 - Bbb 1' }), 3);
  assert.equal(getExpectedStartggRaceCount({ displayScore: 'Aaa W - Bbb L' }), 1);
  assert.equal(getExpectedStartggRaceCount({ scoresCsv: '2-1' }), 3);
  assert.equal(getExpectedStartggRaceCount({ scoresCsv: '2-0' }), 2);
});

test('expected races of a match: one set per game, the unplayed 0-0 set aside', () => {
  assert.equal(getExpectedStartggRaceCount({ scoresCsv: '1-0,0-1,1-0' }), 3);
  assert.equal(getExpectedStartggRaceCount({ scoresCsv: '1-0,0-1,0-0' }), 2);
  assert.equal(getExpectedStartggRaceCount({ scoresCsv: '3-1,2-3' }), 2);
});

test('expected races of a match: finish times written as the score are one race', () => {
  assert.equal(getExpectedStartggRaceCount({ scoresCsv: '31532-31110' }), 1);
  assert.equal(getExpectedStartggRaceCount({ scoresCsv: '14205-0' }), 1);
});

test('expected races of a match: at least one, whatever the score', () => {
  assert.equal(getExpectedStartggRaceCount({}), 1);
  assert.equal(getExpectedStartggRaceCount(null), 1);
  assert.equal(getExpectedStartggRaceCount({ displayScore: 'DQ' }), 1);
  assert.equal(getExpectedStartggRaceCount({ scoresCsv: '0-0' }), 1);
  assert.equal(getExpectedStartggRaceCount({ scoresCsv: 'not a score' }), 1);
});

test('free slot: a match takes as many races as games were played', () => {
  assert.equal(hasAvailableStartggSlot({ scoresCsv: '2-1', raceUrls: ['a', 'b'] }), true);
  assert.equal(hasAvailableStartggSlot({ scoresCsv: '2-1', raceUrls: ['a', 'b', 'c'] }), false);
  assert.equal(hasAvailableStartggSlot({ scoresCsv: '1-0' }), true);
  assert.equal(hasAvailableStartggSlot({ scoresCsv: '1-0', raceUrl: 'a' }), false);
});

test('free slot: a race already linked to the match keeps its place', () => {
  assert.equal(hasAvailableStartggSlot({ scoresCsv: '2-1', raceUrls: ['a', 'b', 'c'] }, 'b'), true);
  assert.equal(hasAvailableStartggSlot({ scoresCsv: '1-0', raceUrl: 'a' }, 'a'), true);
  assert.equal(hasAvailableStartggSlot({ scoresCsv: '1-0', raceUrl: 'a' }, 'z'), false);
});

test('free slot: a "Game 3" label proves three games when only the winner was recorded', () => {
  const match = { scoresCsv: '1-0', raceUrls: ['a'] };
  assert.equal(hasAvailableStartggSlot(match, 'z', 3), true);
  assert.equal(hasAvailableStartggSlot({ ...match, maxGameNumber: 3 }, 'z'), true);
  assert.equal(hasAvailableStartggSlot({ ...match, raceUrls: ['a', 'b', 'c'] }, 'z', 3), false);
});
