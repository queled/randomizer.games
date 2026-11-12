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

test('a tournament title names its game unless its own name does', () => {
  const { tournamentTitle } = require('../services/seo-pages');
  assert.equal(tournamentTitle('Winter Cup 3', 'Some Game Randomizer', 'en'), 'Winter Cup 3 - Some Game Randomizer - Randomizer');
  assert.equal(tournamentTitle('Some Game Randomizer Winter Cup', 'Some Game Randomizer', 'en'), 'Some Game Randomizer Winter Cup - Tournament - Randomizer');
  assert.equal(tournamentTitle('Some Game Randomizer Winter Cup', 'Some Game Randomizer', 'fr'), 'Some Game Randomizer Winter Cup - Tournoi - Randomizer');
  assert.equal(tournamentTitle('Winter Cup 3', null, 'en'), 'Winter Cup 3 - Tournament - Randomizer');
});

test('players are linked once each, by name, whatever their place', () => {
  const { playerLinks } = require('../services/seo-pages');
  assert.deepEqual(playerLinks([
    { userId: 'abc123', name: 'Zed' },
    { userId: null, name: 'anna b' },
    { userId: 'abc123', name: 'Zed again' },
    { userId: null, name: '' }
  ]), [
    { path: '/players/name/anna%20b', label: 'anna b' },
    { path: '/players/abc123', label: 'Zed' }
  ]);
});

test('a description keeps its text, without its markup', () => {
  const { plainText } = require('../services/seo-pages');
  assert.equal(plainText('<p>Rules &amp; <b>format</b></p>\n<script>alert(1)</script><p>Sign&nbsp;up &lt;here&gt;</p>'), 'Rules & format Sign up <here>');
  assert.equal(plainText(undefined), '');
  assert.equal(plainText('<br>  <br>'), '');
});
