const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSystemctlShow, parseSystemdDate, unitState, aptConfigValue, parseScheduledShutdown } = require('../services/system-health');

const SHOWN = `Id=db.service
LoadState=loaded
ActiveState=active
SubState=running
UnitFileState=enabled
ActiveEnterTimestamp=Mon 2026-01-05 10:00:00 UTC

NextElapseUSecRealtime=Tue 2026-01-06 07:00:00 UTC
Id=updates.timer
LoadState=loaded
ActiveState=active
SubState=waiting
UnitFileState=enabled

Id=missing.service
LoadState=not-found
ActiveState=inactive
SubState=dead
UnitFileState=
`;

test('systemctl show gives one unit per block, whatever the order of its keys', () => {
  const units = parseSystemctlShow(SHOWN);
  assert.deepEqual(units.map(u => u.Id), ['db.service', 'updates.timer', 'missing.service']);
  assert.equal(units[1].NextElapseUSecRealtime, 'Tue 2026-01-06 07:00:00 UTC');
  assert.equal(units[2].UnitFileState, '');
});

test('systemd dates are read as UTC, missing ones stay null', () => {
  assert.equal(parseSystemdDate('Mon 2026-01-05 10:00:00 UTC').toISOString(), '2026-01-05T10:00:00.000Z');
  assert.equal(parseSystemdDate('n/a'), null);
  assert.equal(parseSystemdDate(''), null);
});

test('a service running but not started at boot is a warning, a stopped or missing one an error', () => {
  const [db, , missing] = parseSystemctlShow(SHOWN);
  assert.equal(unitState(db), 'ok');
  assert.equal(unitState({ ...db, UnitFileState: 'disabled' }), 'warning');
  assert.equal(unitState({ ...db, ActiveState: 'failed' }), 'error');
  assert.equal(unitState(missing), 'error');
  assert.equal(unitState(undefined), 'error');
});

test('apt-config values are read by their exact key', () => {
  const dump = 'Unattended-Upgrade::Automatic-Reboot "true";\nUnattended-Upgrade::Automatic-Reboot-Time "04:00";\n';
  assert.equal(aptConfigValue(dump, 'Unattended-Upgrade::Automatic-Reboot'), 'true');
  assert.equal(aptConfigValue(dump, 'Unattended-Upgrade::Automatic-Reboot-Time'), '04:00');
  assert.equal(aptConfigValue(dump, 'Unattended-Upgrade::Automatic-Reboot-WithUsers'), null);
});

test('a scheduled shutdown gives its date and mode', () => {
  const scheduled = parseScheduledShutdown('USEC=1767672000000000\nWARN_WALL=1\nMODE=reboot\n');
  assert.equal(scheduled.at.toISOString(), '2026-01-06T04:00:00.000Z');
  assert.equal(scheduled.mode, 'reboot');
  assert.equal(parseScheduledShutdown(null), null);
});
