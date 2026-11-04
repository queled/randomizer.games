const test = require('node:test');
const assert = require('node:assert');
const { buildTournamentQuery } = require('../helpers/game-matching');

test('a linked tournament belongs to its game only, names match unlinked ones', () => {
  const query = buildTournamentQuery({ _id: 'g1', name: 'Adventure' }, 'adventure');
  assert.deepStrictEqual(query.$or[0], { game: 'g1' });
  assert.strictEqual(query.$or[1].game, null);
  assert.ok(query.$or[1].$or.some(c => c.gameName.$regex.test('Zelda II: The Adventure of Link')));
});

test('without a game document, only unlinked tournaments match by name', () => {
  const query = buildTournamentQuery(null, 'z2');
  assert.strictEqual(query.$or.length, 1);
  assert.strictEqual(query.$or[0].game, null);
});
