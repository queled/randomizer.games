const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePlayerName, buildAliasIndex, getCanonicalName, getAliases } = require('../helpers/player-aliases');
const { buildPlayerRacesFilter } = require('../helpers/player-races-filter');

test('normalizePlayerName ignores case, accents and extra spaces', () => {
  assert.equal(normalizePlayerName('  Élodie   la  Rapide '), 'elodie la rapide');
  assert.equal(normalizePlayerName(0), '0');
  assert.equal(normalizePlayerName(null), '');
});

test('alias index resolves aliases to the canonical name', () => {
  const index = buildAliasIndex([
    { name: 'Alpha', aliases: ['Alpha_FR', 'alpha', 'Alf'] },
    { name: 'Bravo' },
    { name: '', aliases: ['Ghost'] }
  ]);
  assert.equal(getCanonicalName(index, 'ALF'), 'Alpha');
  assert.equal(getCanonicalName(index, 'Bravo'), 'Bravo');
  assert.equal(getCanonicalName(index, 'Ghost'), 'Ghost');
  // The canonical name itself is not an alias
  assert.deepEqual(getAliases(index, 'alpha'), ['Alpha_FR', 'Alf']);
  assert.deepEqual(getAliases(index, 'Bravo'), []);
  assert.equal(getCanonicalName(null, 'Alpha'), 'Alpha');
});

test('player races filter: aliases never match a racetime account', () => {
  const { filter, isPlayerEntrant } = buildPlayerRacesFilter({ userId: 'u1', names: ['Alpha'], aliases: ['Alf.'] });
  assert.equal(filter.$or.length, 3);

  assert.equal(isPlayerEntrant({ userId: 'u1', userName: 'Renamed' }), true);
  assert.equal(isPlayerEntrant({ userId: 'u2', userName: 'ALPHA' }), true);
  assert.equal(isPlayerEntrant({ userName: 'alf.' }), true);
  assert.equal(isPlayerEntrant({ userId: 'u3', userName: 'Alf.' }), false);
  // The dot is literal, not a regex wildcard
  assert.equal(isPlayerEntrant({ userName: 'Alfx' }), false);
  assert.equal(isPlayerEntrant({ userName: 'Alphabet' }), false);
});

test('player races filter without any identity matches nothing', () => {
  assert.deepEqual(buildPlayerRacesFilter({}).filter, { _id: null });
});
