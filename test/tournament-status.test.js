const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { calculateTournamentStatus } = require('../helpers/tournament-status');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-06-15T12:00:00Z');
const daysFromNow = (days) => new Date(NOW + days * DAY_MS).toISOString();

const CASES = [
  ['no dates', {}, 'à venir'],
  ['starts later', { startDate: daysFromNow(3) }, 'à venir'],
  ['started, no end', { startDate: daysFromNow(-3) }, 'en cours'],
  ['between start and end', { startDate: daysFromNow(-3), endDate: daysFromNow(3) }, 'en cours'],
  ['past its end', { startDate: daysFromNow(-30), endDate: daysFromNow(-3) }, 'terminé'],
  ['finished state before its end', { startDate: daysFromNow(-3), endDate: daysFromNow(3), state: 'Complete' }, 'terminé'],
  ['finished status', { startDate: daysFromNow(3), status: 'awaiting_review' }, 'terminé'],
  ['started over a year ago', { startDate: daysFromNow(-366), state: 'underway' }, 'terminé'],
  ['active, a little past its end', { startDate: daysFromNow(-30), endDate: daysFromNow(-10), state: 'active' }, 'en cours'],
  ['active, long past its end', { startDate: daysFromNow(-120), endDate: daysFromNow(-90), state: 'active' }, 'terminé'],
  ['underway, last played a little ago', { startDate: daysFromNow(-60), lastActivityAt: daysFromNow(-10), state: 'underway' }, 'en cours'],
  ['underway, nothing played for long', { startDate: daysFromNow(-150), lastActivityAt: daysFromNow(-90), state: 'underway' }, 'terminé'],
  ['past its end, a match still scheduled', {
    startDate: daysFromNow(-120),
    endDate: daysFromNow(-90),
    midosHouse: { schedule: [{ startAt: daysFromNow(-100) }, { startAt: daysFromNow(2) }] }
  }, 'en cours'],
  ['invalid dates', { startDate: 'not a date', endDate: 'nope' }, 'à venir']
];

for (const [name, tournament, expected] of CASES) {
  test(`status: ${name}`, () => {
    assert.equal(calculateTournamentStatus(tournament, NOW), expected);
  });
}

// public/js/api.js mirrors the server status for the pages: both must agree
test('getTournamentStatus() of public/js/api.js agrees with the server', () => {
  const FrozenDate = class extends Date {
    static now() { return NOW; }
  };
  const context = { Date: FrozenDate, fetch: () => { throw new Error('no network in tests'); } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/api.js'), 'utf8'), context);

  for (const [name, tournament] of CASES) {
    assert.equal(context.getTournamentStatus(tournament), calculateTournamentStatus(tournament, NOW), name);
  }
});
