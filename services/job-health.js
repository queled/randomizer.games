const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * State of the server's scheduled tasks, for the admin health page.
 * scripts/cron/run-job.sh writes $LOG_DIR/status/<task>.json at the start and end of
 * each run; the log of the run is $LOG_DIR/<task>.log.
 */

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

// Same tasks and schedules as the crontab in docs/DEPLOYMENT.md (the server runs on
// UTC); maxRun is the sum of the timeouts run-job.sh gives the task's steps
const JOBS = [
  { name: 'racetime', label: 'Courses racetime.gg', cron: '*/5 * * * *', maxRun: 10 * MINUTE },
  { name: 'tournaments-update', label: 'Tournois actifs et rattachements', cron: '2-59/15 * * * *', maxRun: 20 * MINUTE },
  { name: 'schedule-sites', label: "Mido's House, Hyrule Town Hall et localhorst", cron: '7-59/15 * * * *', maxRun: 15 * MINUTE },
  { name: 'race-vods', label: 'VOD et restreams Twitch', cron: '12-59/30 * * * *', maxRun: 20 * MINUTE },
  { name: 'rando-list', label: 'rando-list', cron: '0 6 * * *', maxRun: 20 * MINUTE },
  { name: 'archipelago', label: 'Jeux Archipelago et Multiworld', cron: '20 6 * * *', maxRun: 15 * MINUTE },
  { name: 'tournaments-discover', label: 'Découverte de tournois et asyncs ALTTPR', cron: '0 7 * * *', maxRun: 20 * MINUTE },
  { name: 'players', label: 'Joueurs et comptes racetime', cron: '30 7 * * *', maxRun: 70 * MINUTE },
  { name: 'challonge-check', label: 'Quota API Challonge', cron: '45 7 * * *', maxRun: 2 * MINUTE },
  { name: 'backup', label: 'Sauvegarde de la base', cron: '30 3 * * *', maxRun: 30 * MINUTE }
];

// Values of one cron field: *, n, a-b, with an optional /step, comma-separated
function cronField(field, min, max) {
  const values = new Set();
  for (const part of field.split(',')) {
    const [range, step] = part.split('/');
    let [from, to] = range === '*' ? [min, max] : range.split('-').map(Number);
    if (to === undefined) to = step ? max : from;
    for (let value = from; value <= to; value += Number(step) || 1) values.add(value);
  }
  return [...values].sort((a, b) => a - b);
}

// Minutes and hours (UTC) of a task; the crontab only uses these two fields
function parseCron(cron) {
  const [minute, hour] = cron.split(/\s+/);
  return { minutes: cronField(minute, 0, 59), hours: cronField(hour, 0, 23) };
}

// Time between two runs, for evenly spaced schedules like the crontab's
function periodOf({ minutes, hours }) {
  if (hours.length === 24) return (60 / minutes.length) * MINUTE;
  return DAY / hours.length;
}

function nextRun({ minutes, hours }, now) {
  const next = new Date(now);
  next.setUTCSeconds(0, 0);
  for (let i = 0; i < 2 * 24 * 60; i++) {
    next.setUTCMinutes(next.getUTCMinutes() + 1);
    if (minutes.includes(next.getUTCMinutes()) && hours.includes(next.getUTCHours())) return next;
  }
  return null;
}

const LOG_TAIL_BYTES = 8 * 1024;
const LOG_TAIL_LINES = 20;

function logDir() {
  return process.env.LOG_DIR || path.join(os.homedir(), 'logs');
}

function readStatus(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(logDir(), 'status', `${name}.json`), 'utf8'));
  } catch {
    return null;
  }
}

// Last lines of the task's log, from the start of its last run
function readLogTail(name, maxLines = LOG_TAIL_LINES, maxBytes = LOG_TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(path.join(logDir(), `${name}.log`), 'r');
    const { size } = fs.fstatSync(fd);
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n').filter(Boolean);
    const lastStart = lines.map((line) => line.includes(`début ${name}`)).lastIndexOf(true);
    return lines.slice(Math.max(lastStart, 0)).slice(-maxLines);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function toDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

/**
 * ok: last run succeeded and is recent; running: a run is under way;
 * error: last run failed, or a run outlasts its timeouts;
 * late: no success for over two periods; unknown: never ran on this server.
 */
function jobState(job, status, now) {
  if (!status) return 'unknown';
  const startedAt = toDate(status.startedAt);
  if (status.state === 'running' && startedAt) {
    return now - startedAt > job.maxRun + 5 * MINUTE ? 'error' : 'running';
  }
  if (status.exitCode !== 0 && status.exitCode !== null) return 'error';
  const lastSuccessAt = toDate(status.lastSuccessAt);
  if (!lastSuccessAt || now - lastSuccessAt > 2 * job.period + job.maxRun) return 'late';
  return 'ok';
}

function newestBackupAt() {
  const dir = path.resolve(process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups'));
  try {
    const times = fs.readdirSync(dir)
      .filter((name) => name.endsWith('.archive.gz'))
      .map((name) => fs.statSync(path.join(dir, name)).mtime);
    return times.length ? new Date(Math.max(...times)) : null;
  } catch {
    return null;
  }
}

async function newest(Model, field, filter = {}) {
  const doc = await Model.findOne({ ...filter, [field]: { $ne: null } })
    .sort({ [field]: -1 })
    .select(field)
    .lean();
  return field.split('.').reduce((value, key) => value?.[key], doc) || null;
}

/**
 * Latest data each task wrote in the database, a check independent from the status
 * files: a task can succeed without doing its work (expired token, empty answers).
 */
async function lastDataByJob({ Game, Tournament, Race }) {
  const [race, scheduleSites, vods, randoList, backup] = await Promise.all([
    newest(Race, 'createdAt'),
    newest(Tournament, 'midosHouse.lastSync'),
    newest(Race, 'vodSearchedAt'),
    newest(Game, 'integrations.randoList.lastSync'),
    newestBackupAt()
  ]);
  return {
    racetime: { at: race, label: 'dernière course enregistrée' },
    'schedule-sites': { at: scheduleSites, label: "dernière lecture de Mido's House ou Hyrule Town Hall" },
    'race-vods': { at: vods, label: 'dernière recherche de VOD' },
    'rando-list': { at: randoList, label: 'dernière mise à jour des jeux' },
    backup: { at: backup, label: 'dernière archive' }
  };
}

async function getJobsHealth(models, now = Date.now()) {
  const lastData = await lastDataByJob(models);
  return JOBS.map((job) => {
    const schedule = parseCron(job.cron);
    const period = periodOf(schedule);
    const status = readStatus(job.name);
    const state = jobState({ ...job, period }, status, now);
    const startedAt = toDate(status?.startedAt);
    const endedAt = toDate(status?.endedAt);
    return {
      name: job.name,
      label: job.label,
      cron: job.cron,
      everyMinutes: period / MINUTE,
      // Minutes past the hour of sub-daily tasks, start times of daily ones
      minutes: schedule.minutes,
      nextRunAt: nextRun(schedule, now),
      state,
      startedAt,
      // While a run is under way, endedAt and exitCode are those of the previous one
      endedAt,
      durationMs: status?.state === 'done' && startedAt && endedAt ? endedAt - startedAt : null,
      exitCode: status?.exitCode ?? null,
      lastSuccessAt: toDate(status?.lastSuccessAt),
      consecutiveFailures: status?.consecutiveFailures || 0,
      lastData: lastData[job.name] || null,
      logTail: state === 'error' || state === 'late' ? readLogTail(job.name) : []
    };
  });
}

// The whole last run of a task, for the admin's Synchronisation tab
function readJobLog(name) {
  return readLogTail(name, 400, 64 * 1024);
}

module.exports = { JOBS, getJobsHealth, jobState, readJobLog };
