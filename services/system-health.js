const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

/**
 * Services the site needs on the VPS and the state of its system updates, for the
 * admin health page. Everything here is readable without root: systemctl show,
 * apt-config and the files apt and systemd leave in /var and /run.
 */

// pm2 startup names its unit after the user it runs the site as
const UNITS = () => [
  { unit: 'mongod.service', label: 'MongoDB', role: 'Base de données' },
  { unit: 'nginx.service', label: 'nginx', role: 'Proxy web et HTTPS' },
  { unit: `pm2-${os.userInfo().username}.service`, label: 'PM2', role: 'Relance le site au démarrage' },
  { unit: 'cron.service', label: 'cron', role: 'Tâches planifiées' },
  { unit: 'apt-daily-upgrade.timer', label: 'unattended-upgrades', role: 'Mises à jour de sécurité' }
];

const PROPERTIES = ['Id', 'LoadState', 'ActiveState', 'SubState', 'UnitFileState', 'ActiveEnterTimestamp', 'NextElapseUSecRealtime', 'LastTriggerUSec'];

function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 5000 }, (error, stdout) => resolve(error && !stdout ? null : String(stdout)));
  });
}

// `systemctl show a b --property=…` prints one block of Key=Value lines per unit
function parseSystemctlShow(output) {
  return String(output || '').split(/\n\s*\n/).map((block) => {
    const unit = {};
    for (const line of block.split('\n')) {
      const at = line.indexOf('=');
      if (at > 0) unit[line.slice(0, at)] = line.slice(at + 1).trim();
    }
    return unit;
  }).filter(unit => unit.Id);
}

// systemd dates read "Thu 2026-11-05 19:23:00 UTC"; empty or "n/a" when there is none
function parseSystemdDate(value) {
  const match = /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (UTC|GMT)$/.exec(value || '');
  return match ? new Date(`${match[1]}T${match[2]}Z`) : null;
}

// ok: running and started at boot · warning: running but would stay down after a
// reboot · error: stopped or missing
function unitState(unit) {
  if (!unit || unit.LoadState !== 'loaded') return 'error';
  if (unit.ActiveState !== 'active') return 'error';
  return unit.UnitFileState === 'enabled' ? 'ok' : 'warning';
}

// apt-config dump prints `Key "value";`
function aptConfigValue(dump, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^${escaped} "([^"]*)";$`, 'm').exec(dump || '');
  return match ? match[1] : null;
}

// /run/systemd/shutdown/scheduled holds USEC=<microseconds since epoch> and MODE=reboot|poweroff
function parseScheduledShutdown(content) {
  const usec = /^USEC=(\d+)$/m.exec(content || '');
  if (!usec) return null;
  return { at: new Date(Number(usec[1]) / 1000), mode: /^MODE=(\w+)$/m.exec(content)?.[1] || 'reboot' };
}

const readText = (file) => fs.promises.readFile(file, 'utf8').catch(() => null);
const mtime = (file) => fs.promises.stat(file).then(stat => stat.mtime, () => null);

async function getSystemHealth() {
  // Only the Linux server runs these services; nothing to show on a dev machine
  if (process.platform !== 'linux') return null;

  const units = UNITS();
  const [shown, aptDump, rebootFlag, rebootPackages, scheduled, lastUpgradeAt] = await Promise.all([
    run('systemctl', ['show', ...units.map(u => u.unit), `--property=${PROPERTIES.join(',')}`]),
    run('apt-config', ['dump']),
    fs.promises.access('/var/run/reboot-required').then(() => true, () => false),
    readText('/var/run/reboot-required.pkgs'),
    readText('/run/systemd/shutdown/scheduled'),
    mtime('/var/lib/apt/periodic/upgrade-stamp')
  ]);
  if (shown === null) return null;

  const byId = new Map(parseSystemctlShow(shown).map(unit => [unit.Id, unit]));
  const services = units.map(({ unit, label, role }) => {
    const found = byId.get(unit);
    return {
      unit,
      label,
      role,
      state: unitState(found),
      active: found?.ActiveState || 'absent',
      sub: found?.SubState || null,
      enabled: found?.UnitFileState || null,
      since: parseSystemdDate(found?.ActiveEnterTimestamp)
    };
  });
  const timer = byId.get('apt-daily-upgrade.timer');
  const autoReboot = aptConfigValue(aptDump, 'Unattended-Upgrade::Automatic-Reboot') === 'true';

  return {
    services,
    updates: {
      lastRunAt: lastUpgradeAt,
      nextRunAt: parseSystemdDate(timer?.NextElapseUSecRealtime),
      autoReboot,
      autoRebootTime: autoReboot ? aptConfigValue(aptDump, 'Unattended-Upgrade::Automatic-Reboot-Time') || 'now' : null
    },
    reboot: {
      required: rebootFlag,
      packages: [...new Set(String(rebootPackages || '').split('\n').map(p => p.trim()).filter(Boolean))],
      scheduled: parseScheduledShutdown(scheduled),
      kernel: os.release(),
      bootedAt: new Date(Date.now() - os.uptime() * 1000)
    }
  };
}

module.exports = { getSystemHealth, parseSystemctlShow, parseSystemdDate, unitState, aptConfigValue, parseScheduledShutdown };
