const test = require('node:test');
const assert = require('node:assert');
const challonge = require('../services/challonge');

function withAnswer(tournament, run) {
  const { get, readCache } = challonge;
  challonge.readCache = () => null;
  challonge.get = async () => ({ tournament: { participants: [], matches: [], ...tournament } });
  return run().finally(() => { challonge.get = get; challonge.readCache = readCache; });
}

test('a bracket not started yet takes the start date planned by the organizer', () =>
  withAnswer({ id: 1, state: 'pending', started_at: null, start_at: '2026-01-15T20:00:00.000+01:00' }, async () => {
    const { tournamentData } = await challonge.getTournamentDetails('1');
    assert.strictEqual(tournamentData.startedAt, '2026-01-15T20:00:00.000+01:00');
  }));

test('the actual start wins over the planned one', () =>
  withAnswer({ id: 1, state: 'underway', started_at: '2026-01-16T18:00:00.000+01:00', start_at: '2026-01-15T20:00:00.000+01:00' }, async () => {
    const { tournamentData } = await challonge.getTournamentDetails('1');
    assert.strictEqual(tournamentData.startedAt, '2026-01-16T18:00:00.000+01:00');
  }));
