const test = require('node:test');
const assert = require('node:assert/strict');
const { JOBS, jobState, parseCron, periodOf, nextRun } = require('../services/job-health');

const DAY = 24 * 60 * 60 * 1000;

test('a daily task runs every day at its time', () => {
  const schedule = parseCron('30 8 * * *');
  assert.equal(periodOf(schedule), DAY);
  assert.equal(nextRun(schedule, new Date('2026-11-17T09:00:00Z')).toISOString(), '2026-11-18T08:30:00.000Z');
});

test('a weekly task waits for its weekday', () => {
  const schedule = parseCron('30 11 * * 1');
  assert.equal(periodOf(schedule), 7 * DAY);
  // 2026-11-17 is a Tuesday: next Monday is the 23rd
  assert.equal(nextRun(schedule, new Date('2026-11-17T12:00:00Z')).toISOString(), '2026-11-23T11:30:00.000Z');
});

test('a task every 15 minutes keeps its period', () => {
  assert.equal(periodOf(parseCron('2-59/15 * * * *')), 15 * 60 * 1000);
});

test('an exit code a task gives to a measured state is a warning, not a failure', () => {
  const job = JOBS.find((j) => j.name === 'challonge-check');
  const now = new Date('2026-01-05T12:00:00Z');
  const status = { state: 'done', startedAt: '2026-01-05T10:15:00Z', exitCode: 1, lastSuccessAt: '2025-12-20T10:15:00Z' };
  assert.equal(jobState({ ...job, period: DAY }, status, now), 'warning');
  assert.equal(jobState({ ...job, period: DAY }, { ...status, exitCode: 2 }, now), 'error');
  assert.equal(jobState({ ...JOBS.find((j) => j.name === 'indexnow'), period: DAY }, status, now), 'error');
});
