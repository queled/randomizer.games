const test = require('node:test');
const assert = require('node:assert/strict');
const { hackTitle } = require('../scripts/sync-rando-list');

const game = (name, categoryName) => ({ name, integrations: { twitch: { categoryName } } });

test('hackTitle gives the title of a hack named after its base game', () => {
  assert.equal(hackTitle(game('Star Ranger: Frozen Core', 'Star Ranger')), 'Frozen Core');
  assert.equal(hackTitle(game('Star Ranger: Origins – Night Shift', 'Star Ranger: Origins')), 'Night Shift');
  assert.equal(hackTitle(game('Star Ranger - Frozen Core', 'Star Ranger')), 'Frozen Core');
});

test('hackTitle leaves other games alone', () => {
  assert.equal(hackTitle(game('Star Ranger', 'Star Ranger')), null);
  assert.equal(hackTitle(game('Star Ranger Arcade', 'Star Ranger')), null);
  assert.equal(hackTitle(game('Star Ranger 2: Echoes', 'Star Ranger 2: Echoes')), null);
  assert.equal(hackTitle(game('Frozen Core', 'Star Ranger')), null);
  assert.equal(hackTitle({ name: 'Star Ranger: Frozen Core' }), null);
});
