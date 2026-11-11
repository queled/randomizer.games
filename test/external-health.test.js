const test = require('node:test');
const assert = require('node:assert/strict');
const { challongeFromJob } = require('../services/external-health');

test('Challonge takes its state from the daily quota check, without calling the API', (t) => {
  const key = process.env.CHALLONGE_API_KEY;
  process.env.CHALLONGE_API_KEY = 'test-key';
  t.after(() => { if (key === undefined) delete process.env.CHALLONGE_API_KEY; else process.env.CHALLONGE_API_KEY = key; });
  const startedAt = '2026-01-05T10:15:00Z';

  assert.equal(challongeFromJob({ state: 'ok', exitCode: 0, startedAt }).status, 'ok');
  assert.equal(challongeFromJob({ state: 'running', startedAt }).status, 'ok');
  assert.deepEqual(
    [challongeFromJob({ state: 'error', exitCode: 1, startedAt }).status, challongeFromJob({ state: 'error', exitCode: 1, startedAt }).detail],
    ['warning', 'quota épuisé']
  );
  assert.equal(challongeFromJob({ state: 'error', exitCode: 2, startedAt }).status, 'error');
  assert.equal(challongeFromJob({ state: 'late', exitCode: 0, startedAt }).detail, 'contrôle en retard');
  assert.equal(challongeFromJob(undefined).detail, 'jamais vérifié');

  delete process.env.CHALLONGE_API_KEY;
  assert.equal(challongeFromJob({ state: 'ok', startedAt }).detail, 'clé absente');
});
