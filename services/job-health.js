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

// Same tasks and frequencies as the crontab in docs/DEPLOYMENT.md; maxRun is the sum
// of the timeouts run-job.sh gives the task's steps
const JOBS = [
  { name: 'racetime', label: 'Courses racetime.gg', every: 5 * MINUTE, maxRun: 10 * MINUTE },
  { name: 'tournaments-update', label: 'Tournois actifs et rattachements', every: 15 * MINUTE, maxRun: 20 * MINUTE },
  { name: 'midos-house', label: "Mido's House", every: 15 * MINUTE, maxRun: 5 * MINUTE },
  { name: 'race-vods', label: 'VOD et restreams Twitch', every: 30 * MINUTE, maxRun: 20 * MINUTE },
  { name: 'tournaments-discover', label: 'Découverte de tournois', every: DAY, maxRun: 15 * MINUTE },
  { name: 'rando-list', label: 'rando-list', every: DAY, maxRun: 20 * MINUTE },
  { name: 'players', label: 'Joueurs et comptes racetime', every: DAY, maxRun: 70 * MINUTE },
  { name: 'challonge-check', label: 'Quota API Challonge', every: DAY, maxRun: 2 * MINUTE },
  { name: 'backup', label: 'Sauvegarde de la base', every: DAY, maxRun: 30 * MINUTE }
];

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
function readLogTail(name) {
  let fd;
  try {
    fd = fs.openSync(path.join(logDir(), `${name}.log`), 'r');
    const { size } = fs.fstatSync(fd);
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n').filter(Boolean);
    const lastStart = lines.map((line) => line.includes(`début ${name}`)).lastIndexOf(true);
    return lines.slice(Math.max(lastStart, 0)).slice(-LOG_TAIL_LINES);
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
  if (!lastSuccessAt || now - lastSuccessAt > 2 * job.every + job.maxRun) return 'late';
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
  const [race, midosHouse, vods, randoList, backup] = await Promise.all([
    newest(Race, 'createdAt'),
    newest(Tournament, 'midosHouse.lastSync'),
    newest(Race, 'vodSearchedAt'),
    newest(Game, 'integrations.randoList.lastSync'),
    newestBackupAt()
  ]);
  return {
    racetime: { at: race, label: 'dernière course enregistrée' },
    'midos-house': { at: midosHouse, label: "dernière lecture de Mido's House" },
    'race-vods': { at: vods, label: 'dernière recherche de VOD' },
    'rando-list': { at: randoList, label: 'dernière mise à jour des jeux' },
    backup: { at: backup, label: 'dernière archive' }
  };
}

async function getJobsHealth(models, now = Date.now()) {
  const lastData = await lastDataByJob(models);
  return JOBS.map((job) => {
    const status = readStatus(job.name);
    const state = jobState(job, status, now);
    return {
      name: job.name,
      label: job.label,
      everyMinutes: job.every / MINUTE,
      state,
      startedAt: toDate(status?.startedAt),
      endedAt: toDate(status?.endedAt),
      // While a run is under way, the code of the previous one
      exitCode: status?.exitCode ?? null,
      lastSuccessAt: toDate(status?.lastSuccessAt),
      consecutiveFailures: status?.consecutiveFailures || 0,
      lastData: lastData[job.name] || null,
      logTail: state === 'error' || state === 'late' ? readLogTail(job.name) : []
    };
  });
}

module.exports = { JOBS, getJobsHealth, jobState };
