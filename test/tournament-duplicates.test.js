const test = require('node:test');
const assert = require('node:assert/strict');
const { isSamePlayerField } = require('../helpers/tournament-duplicates');

const field = n => Array.from({ length: n }, (_, i) => `Player ${i + 1}`);

test('the same field written differently is the same tournament', () => {
  const challonge = field(16);
  const startgg = challonge.map(name => name.toUpperCase().replace(' ', '_'));
  assert.equal(isSamePlayerField(challonge, startgg), true);
});

test('a few players missing on one side still match', () => {
  assert.equal(isSamePlayerField(field(16), field(14)), true);
});

test('a top 8 is not the same tournament as its 32-player qualifier', () => {
  assert.equal(isSamePlayerField(field(32), field(8)), false);
});

test('fields sharing few players are different tournaments', () => {
  const other = [...field(8).slice(0, 4), 'Someone A', 'Someone B', 'Someone C', 'Someone D'];
  assert.equal(isSamePlayerField(field(8), other), false);
});

test('tiny fields never count as duplicates', () => {
  assert.equal(isSamePlayerField(field(3), field(3)), false);
});
