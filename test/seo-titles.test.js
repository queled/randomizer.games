const test = require('node:test');
const assert = require('node:assert/strict');
const { gameTitle } = require('../services/seo-pages');
const { TEXTS } = require('../services/seo-texts');

test('a game title names what its page holds, in the language of the page', () => {
  const busy = { totalRaces: 120, totalTournaments: 4 };
  assert.equal(gameTitle('Some Game Randomizer', busy, true, 'en'), 'Some Game Randomizer: Races, Tournaments and Leaderboards - Randomizer');
  assert.equal(gameTitle('Some Game Randomizer', busy, true, 'fr'), 'Some Game Randomizer : courses, tournois et classements - Randomizer');
  assert.equal(gameTitle('Some Game Randomizer', busy, true, 'de'), 'Some Game Randomizer: Rennen, Turniere und Bestenlisten - Randomizer');
});

test('a game title leaves out what the game does not have', () => {
  assert.equal(gameTitle('Some Game Randomizer', { totalRaces: 3, totalTournaments: 0 }, false, 'en'), 'Some Game Randomizer: Races and Leaderboards - Randomizer');
  assert.equal(gameTitle('Some Game Randomizer', { totalRaces: 0, totalTournaments: 2 }, false, 'en'), 'Some Game Randomizer: Tournaments - Randomizer');
  assert.equal(gameTitle('Some Game Randomizer', { totalRaces: 0, totalTournaments: 0 }, true, 'en'), 'Some Game Randomizer: History and Resources - Randomizer');
  assert.equal(gameTitle('Some Game Randomizer', { totalRaces: 0, totalTournaments: 0 }, false, 'en'), 'Some Game Randomizer: Resources - Randomizer');
  // Counts not computed yet
  assert.equal(gameTitle('Some Game Randomizer', null, true, 'en'), 'Some Game Randomizer - Randomizer');
});

test('every language has the words of a game title', () => {
  for (const [lang, t] of Object.entries(TEXTS)) {
    assert.match(t.gameTitle, /\{title\}.*\{topics\}/, lang);
    assert.deepEqual(Object.keys(t.topics), ['races', 'tournaments', 'leaderboards', 'history', 'resources'], lang);
  }
});

test('the games list links every game worth a result, by name, in the language of the page', () => {
  const { gameLinks, renderLinks } = require('../services/seo-pages');
  const games = [
    { id: 'zeta', randomizer: { displayName: 'Zeta Randomizer' }, totalRaces: 4, totalTournaments: 0 },
    { id: 'empty', randomizer: { displayName: 'Empty Randomizer' }, totalRaces: 0, totalTournaments: 0 },
    { id: 'Story', randomizer: { displayName: 'alpha & co Randomizer' }, totalRaces: 0, totalTournaments: 0 },
    { id: 'off', randomizer: { displayName: 'Off Randomizer' }, totalRaces: 9, totalTournaments: 1, enabled: false }
  ];
  const links = gameLinks(games, new Set(['story']));
  assert.deepEqual(links, [
    { path: '/games/Story', label: 'alpha & co Randomizer' },
    { path: '/games/zeta', label: 'Zeta Randomizer' }
  ]);
  assert.equal(
    renderLinks(links, 'fr', 'page-links'),
    '<ul class="page-links"><li><a href="/fr/games/Story">alpha &amp; co Randomizer</a></li><li><a href="/fr/games/zeta">Zeta Randomizer</a></li></ul>'
  );
  assert.equal(renderLinks(links, 'en', 'page-links').includes('href="/games/zeta"'), true);
  assert.equal(renderLinks([], 'en', 'page-links'), '');
});
