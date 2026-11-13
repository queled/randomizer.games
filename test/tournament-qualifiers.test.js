const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseQualifierLabel,
  getQualifierWindow,
  matchQualifierToTournament
} = require('../services/tournament-qualifiers');

const DAY_MS = 24 * 60 * 60 * 1000;
const START = Date.parse('2026-06-01T00:00:00Z');
const TOURNAMENT = { name: 'Fancy Cup Season 3', gameName: 'Some Game', startDate: new Date(START).toISOString() };
const daysFromStart = (days) => new Date(START + days * DAY_MS).toISOString();
const entrants = (count) => Array.from({ length: count }, (_, index) => ({ user: `p${index}` }));

// A finished qualifier room, played two weeks before the bracket
const room = (info, extra = {}) => ({
  info, status: 'finished', startedAt: daysFromStart(-14), entrants: entrants(12), ...extra
});

test('qualifier label: every usual wording gives its number or letter', () => {
  const CASES = [
    ['Qualifier #13', '13'],
    ['qualifier 18', '18'],
    ['Qualifier race #3', '3'],
    ['Qualifiers #1', '1'],
    ['Qualification 2', '2'],
    ['Qualifier B', 'B'],
    ['Live Quals 2', '2'],
    ['Qual 4', '4']
  ];
  for (const [info, index] of CASES) {
    assert.equal(parseQualifierLabel({ info })?.index, index, info);
  }
});

test('qualifier label: not a qualifier without a number, nor a practice or an async room', () => {
  for (const info of [
    'Aaa vs Bbb',
    'Qualifier',
    'Unqualified run 3',
    'Practice Qualifier #2',
    '[ASYNC] S8 Qualifier #3',
    'Mock qualifier 1',
    'Not a qualifier 2'
  ]) {
    assert.equal(parseQualifierLabel({ info }), null, info);
  }
});

test('qualifier label: the event is read before the number and right after it', () => {
  assert.deepEqual(parseQualifierLabel({ info: 'Fancy Cup Season 3: Qualifier #13 (Weekly)' }), {
    label: 'Fancy Cup Season 3: Qualifier #13 (Weekly)',
    index: '13',
    eventTokens: ['fancy', 'cup', 's3']
  });
  assert.deepEqual(parseQualifierLabel({ info: 'Qualifier race #3 Season 2 tournament' }).eventTokens, ['s2']);
  assert.deepEqual(parseQualifierLabel({ info: 'Live Qualifier #4 - Hosted by Someone' }).eventTokens, []);
  assert.deepEqual(parseQualifierLabel({ info: 'Qualifier #4   https://example.com/seed/abc' }).eventTokens, []);
});

test('qualifier label: only the first line of the room info is read', () => {
  assert.equal(parseQualifierLabel({ info: 'Weekly race\nQualifier #2' }), null);
  assert.equal(parseQualifierLabel({ info: 'Qualifier #2\nPractice allowed' }).index, '2');
});

test('qualifier window: from 120 days before the bracket to 14 days after its start', () => {
  assert.deepEqual(getQualifierWindow(TOURNAMENT), {
    minDate: new Date(START - 120 * DAY_MS),
    maxDate: new Date(START + 14 * DAY_MS)
  });
  assert.equal(getQualifierWindow({}), null);
  assert.equal(getQualifierWindow({ startDate: 'not a date' }), null);
  assert.equal(getQualifierWindow(null), null);
});

test('qualifier of a tournament: a label naming it is sure, whatever the room size', () => {
  assert.equal(matchQualifierToTournament(room('Fancy Cup Season 3: Qualifier #2'), TOURNAMENT), 'named');
  assert.equal(matchQualifierToTournament(room('S3 Qualifier 2', { entrants: entrants(2) }), TOURNAMENT), 'named');
});

test('qualifier of a tournament: another season or another event is not its qualifier', () => {
  assert.equal(matchQualifierToTournament(room('Fancy Cup Season 2: Qualifier #2'), TOURNAMENT), null);
  assert.equal(matchQualifierToTournament(room('Other Series: Qualifier #2'), TOURNAMENT), null);
});

test('qualifier of a tournament: a plain label relies on the room goal', () => {
  assert.equal(matchQualifierToTournament(room('Qualifier #2', { goal: 'Fancy Cup' }), TOURNAMENT), 'named');
  assert.equal(matchQualifierToTournament(room('Qualifier #2', { goal: 'Standard Ruleset' }), TOURNAMENT), 'bare');
  assert.equal(matchQualifierToTournament(room('Qualifier #2'), TOURNAMENT), 'bare');
  assert.equal(matchQualifierToTournament(room('Qualifier #2', { goal: 'Other League Season 8' }), TOURNAMENT), null);
});

test('qualifier of a tournament: a plain qualifier of two players may be a match', () => {
  assert.equal(matchQualifierToTournament(room('Qualifier #2', { entrants: entrants(2) }), TOURNAMENT), null);
  assert.equal(matchQualifierToTournament(room('Qualifier #2', { entrants: entrants(3) }), TOURNAMENT), 'bare');
});

test('qualifier of a tournament: only rooms played inside the window', () => {
  const at = (days) => matchQualifierToTournament(room('Fancy Cup Season 3: Qualifier #2', { startedAt: daysFromStart(days) }), TOURNAMENT);
  assert.equal(at(-121), null);
  assert.equal(at(-119), 'named');
  assert.equal(at(13), 'named');
  assert.equal(at(15), null);
  assert.equal(matchQualifierToTournament(room('Fancy Cup Season 3: Qualifier #2'), { name: 'Fancy Cup Season 3' }), null);
});

test('qualifier of a tournament: a room not played yet, or cancelled, does not count', () => {
  for (const status of ['pending', 'open', 'invitational', 'cancelled']) {
    assert.equal(matchQualifierToTournament(room('Fancy Cup Season 3: Qualifier #2', { status }), TOURNAMENT), null, status);
  }
  assert.equal(matchQualifierToTournament(room('Fancy Cup Season 3: Qualifier #2', { status: 'in_progress' }), TOURNAMENT), 'named');
});
