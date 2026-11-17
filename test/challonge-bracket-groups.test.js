const test = require('node:test');
const assert = require('node:assert/strict');
const { orderBrackets } = require('../services/challonge-bracket-groups');

const ids = brackets => brackets.map(b => b.challongeId);
const players = names => names.map(name => ({ name }));
const order = brackets => ids(orderBrackets(brackets, b => b.players));

test('orderBrackets puts the groups before the bracket their players qualified from, whatever the import order', () => {
  // Names may be shortened in the bracket ("Charl" for "Charlie")
  const groups = { challongeId: 'groups', startDate: '2026-02-01T18:00:00Z', players: players(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot']) };
  const bracket = { challongeId: 'bracket', startDate: '2026-03-10T18:00:00Z', players: players(['Alpha', 'Charl', 'Echo', 'Foxtrot']) };
  assert.deepEqual(order([bracket, groups]), ['groups', 'bracket']);
  assert.deepEqual(order([groups, bracket]), ['groups', 'bracket']);
});

test('orderBrackets keeps the order of brackets played side by side, whatever their start dates', () => {
  const brackets = [
    { challongeId: 'gold', startDate: '2026-01-01T18:00:00Z', players: players(['Alpha', 'Bravo']) },
    { challongeId: 'silver', startDate: '2026-02-12T18:00:00Z', players: players(['Charlie', 'Delta']) },
    { challongeId: 'bronze', startDate: '2026-01-29T18:00:00Z', players: players(['Echo', 'Foxtrot']) }
  ];
  assert.deepEqual(order(brackets), ['gold', 'silver', 'bronze']);
});

test('orderBrackets needs most of the later bracket\'s players to come from the earlier one', () => {
  const first = { challongeId: 'first', startDate: '2026-01-01T18:00:00Z', players: players(['Alpha', 'Bravo', 'Charlie']) };
  const other = { challongeId: 'other', startDate: '2026-02-01T18:00:00Z', players: players(['Alpha', 'Delta', 'Echo', 'Foxtrot']) };
  assert.deepEqual(order([other, first]), ['other', 'first']);
});

test('orderBrackets leaves a bracket without start date or players where it is', () => {
  const groups = { challongeId: 'groups', startDate: '2026-02-01T18:00:00Z', players: players(['Alpha', 'Bravo', 'Charlie']) };
  const notStarted = { challongeId: 'next', startDate: null, players: players(['Alpha', 'Bravo']) };
  assert.deepEqual(order([notStarted, groups]), ['next', 'groups']);
});
