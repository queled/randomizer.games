const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSitePath, legacyTarget, localizedPath } = require('../helpers/site-routes');

test('a clean address leads to its page, in its language', () => {
  assert.deepEqual(parseSitePath('/'), { lang: 'en', file: '/index.html', params: {}, path: '/' });
  assert.deepEqual(parseSitePath('/games'), { lang: 'en', file: '/games.html', params: {}, path: '/games' });
  assert.deepEqual(parseSitePath('/fr/games/sample'), { lang: 'fr', file: '/game-detail.html', params: { id: 'sample' }, path: '/games/sample' });
  assert.deepEqual(parseSitePath('/de/players/name/Some%20One'), { lang: 'de', file: '/player-detail.html', params: { name: 'Some One' }, path: '/players/name/Some%20One' });
  assert.deepEqual(parseSitePath('/fr/'), { lang: 'fr', file: '/index.html', params: {}, path: '/' });
});

test('an address has a single spelling', () => {
  assert.deepEqual(parseSitePath('/games/sample/'), { redirect: '/games/sample' });
  assert.deepEqual(parseSitePath('/fr'), { redirect: '/fr/' });
  // A real folder keeps its slash, or the static server would redirect forever
  assert.equal(parseSitePath('/admin/'), null);
  assert.deepEqual(parseSitePath('/fr/games/'), { redirect: '/fr/games' });
});

test('other paths are not pages', () => {
  for (const path of ['/assets/logo.png', '/js/seo.js', '/api/games', '/en/games', '/games/a/b', '/games.html', '/games/%E0%A4%A']) {
    assert.equal(parseSitePath(path), null, path);
  }
});

test('old addresses move to the clean ones, keeping the other parameters', () => {
  assert.deepEqual(legacyTarget('/game-detail.html', { id: 'sample', tab: 'stats' }), { path: '/games/sample?tab=stats' });
  assert.deepEqual(legacyTarget('/player-detail.html', { name: 'Some One' }), { path: '/players/name/Some%20One' });
  assert.deepEqual(legacyTarget('/races.html', { game: 'sample' }), { path: '/races?game=sample' });
  assert.deepEqual(legacyTarget('/index.html', {}), { path: '/' });
  assert.equal(legacyTarget('/404.html', {}), null);
  assert.equal(legacyTarget('/race-detail.html', { url: 'sample/brave-race-1234' }).raceUrl, 'sample/brave-race-1234');
});

test('English pages have no prefix', () => {
  assert.equal(localizedPath('en', '/games'), '/games');
  assert.equal(localizedPath('fr', '/games'), '/fr/games');
  assert.equal(localizedPath('fr', '/'), '/fr/');
});
