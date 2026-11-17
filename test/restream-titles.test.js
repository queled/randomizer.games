const test = require('node:test');
const assert = require('node:assert/strict');
const { titleFitsEvent, titleNamesRace, countNamedPlayers, parseMatchup, sideNamesPlayer } = require('../helpers/restream-titles');

test('titleFitsEvent checks the series and the season named in the title', () => {
  assert.equal(titleFitsEvent('Tournoi FR S6 - Alpha vs Bravo', 'fr', '6'), true);
  assert.equal(titleFitsEvent('Tournoi FR S6 - Alpha vs Bravo', 'fr', '2'), false);
  assert.equal(titleFitsEvent('Tournoi FR - Alpha vs Bravo', 'rsl', '1'), false);
  assert.equal(titleFitsEvent('Alpha vs Bravo', 'rsl', '1'), true);
  // Series keywords only mean something for Mido's House events
  assert.equal(titleFitsEvent('Tournoi FR - Alpha vs Bravo', 'rsl', '1', 'other-site'), true);
});

test('titleNamesRace needs both players of a 1v1, half of a bigger room', () => {
  const duo = [['Alpha', 'alpha_ttv'], ['Bravo']];
  assert.equal(titleNamesRace('Cup: alpha_ttv vs Bravo', duo), true);
  assert.equal(titleNamesRace('Cup: Alpha vs someone', duo), false);
  assert.equal(titleNamesRace('Practice: Alpha vs Bravo', duo), false);
  assert.equal(titleNamesRace('Alpha', [['Alpha']]), false);

  const room = [['Alpha'], ['Bravo'], ['Charlie'], ['Delta'], ['Echo']];
  assert.equal(titleNamesRace('Alpha, Bravo, Charlie', room), true);
  assert.equal(titleNamesRace('Alpha, Bravo', room), false);
});

test('titleNamesRace accepts a 1v1 whose title shortens a name, both sides needed', () => {
  const duo = [['Alpha', 'alpha'], ['BravoV', 'bravo_vodka']];
  assert.equal(titleNamesRace('Restream de Alpha vs Bravo', duo), true);
  assert.equal(titleNamesRace('Cup Round 2 - Bravo vs Alpha (FR)', duo), true);
  // One side only, or the same player on both sides
  assert.equal(titleNamesRace('Alpha vs Charlie', duo), false);
  assert.equal(titleNamesRace('Bravo vs Bravo', duo), false);
  // A side too short to tell
  assert.equal(titleNamesRace('Alpha vs Bra', duo), false);
  // Without "vs", a shortened name is not enough
  assert.equal(titleNamesRace('Alpha et Bravo', duo), false);
  // Practice is never the match
  assert.equal(titleNamesRace('Practice: Alpha vs Bravo', duo), false);
  // Bigger rooms still need full names
  assert.equal(titleNamesRace('Alpha vs Bravo', [['Alpha'], ['BravoV'], ['Charlie']]), false);
});

test('countNamedPlayers ignores names too short to tell', () => {
  assert.equal(countNamedPlayers('Ab vs Bravo', [['Ab'], ['Bravo']]), 1);
});

test('parseMatchup splits a match title', () => {
  assert.deepEqual(parseMatchup('Cup: Round 2 - Alpha vs. Bravo (G2)'), { event: 'Cup: Round 2', sides: ['Alpha', 'Bravo'] });
  assert.deepEqual(parseMatchup('Alpha vs Bravo | French'), { event: '', sides: ['Alpha', 'Bravo'] });
  assert.equal(parseMatchup('Weekly race'), null);
});

test('sideNamesPlayer accepts a name contained in the other, from 4 characters', () => {
  assert.equal(sideNamesPlayer('Mr. Alpha', ['mr__alpha']), true);
  assert.equal(sideNamesPlayer('Alpha', ['Alpha242']), true);
  assert.equal(sideNamesPlayer('Alp', ['Alpha']), false);
  assert.equal(sideNamesPlayer('Alp', ['ALP']), true);
});
