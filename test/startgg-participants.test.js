const test = require('node:test');
const assert = require('node:assert/strict');
const StartGGAPI = require('../services/startgg');

const DAY_MS = 24 * 60 * 60 * 1000;
const entry = (id, name) => ({ entrantId: id, placement: 49, participants: [{ gamerTag: name }] });

test('running event with no set played yet: no rank, not start.gg\'s shared placement', () => {
  const event = {
    startDate: new Date(Date.now() - DAY_MS),
    endDate: new Date(Date.now() + 30 * DAY_MS),
    state: 'ACTIVE',
    standings: [entry('1', 'Alpha'), entry('2', 'Beta')],
    sets: [{ phase: { name: 'Groups' }, round: 1, winnerId: null, entrants: [{ id: '1' }, { id: '2' }] }]
  };
  assert.deepEqual(StartGGAPI.buildParticipants(event).map(p => p.finalRank), [null, null]);
});

test('finished event keeps start.gg\'s placements', () => {
  const event = {
    startDate: new Date(Date.now() - 60 * DAY_MS),
    endDate: new Date(Date.now() - 30 * DAY_MS),
    state: 'COMPLETED',
    standings: [{ ...entry('1', 'Alpha'), placement: 1 }, { ...entry('2', 'Beta'), placement: 2 }],
    sets: []
  };
  assert.deepEqual(StartGGAPI.buildParticipants(event).map(p => p.finalRank), [1, 2]);
});
