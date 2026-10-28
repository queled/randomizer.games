// Tournament status ('à venir' | 'en cours' | 'terminé') computed from the dates
// and the state reported by start.gg / Challonge.
// Mirrored by getTournamentStatus() in public/js/api.js: keep both in sync.

const DAY_MS = 24 * 60 * 60 * 1000;
// A tournament is considered finished one year after its start, whatever its state.
const MAX_DURATION_MS = 365 * DAY_MS;
// How long an 'active' tournament stays 'en cours' after its planned end date,
// so a stale state (sync stopped, organizer never closed it) does not keep it running forever.
const OVERTIME_GRACE_MS = 60 * DAY_MS;

const FINISHED_STATES = ['complete', 'completed', 'awaiting_review'];
const RUNNING_STATES = ['active', 'underway', 'in_progress'];

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d.getTime();
}

function hasUpcomingMatch(tournament, now) {
  const schedule = tournament?.midosHouse?.schedule;
  return Array.isArray(schedule) && schedule.some((s) => (parseDate(s?.startAt) || 0) > now);
}

function calculateTournamentStatus(tournament, now = Date.now()) {
  const start = parseDate(tournament?.startDate);
  // Challonge sets no end before the organizer closes the bracket: its last race or reported score stands in
  const end = parseDate(tournament?.endDate) || parseDate(tournament?.lastActivityAt);
  const state = String(tournament?.state || '').toLowerCase();

  if (FINISHED_STATES.includes(state) || FINISHED_STATES.includes(tournament?.status)) return 'terminé';
  if (start && now - start >= MAX_DURATION_MS) return 'terminé';
  if (start && now < start) return 'à venir';

  if (end && now > end) {
    // Running late: still in progress while matches are scheduled, or for a while if the platform says so.
    if (hasUpcomingMatch(tournament, now)) return 'en cours';
    if (RUNNING_STATES.includes(state) && now - end < OVERTIME_GRACE_MS) return 'en cours';
    return 'terminé';
  }

  return start ? 'en cours' : 'à venir';
}

module.exports = { calculateTournamentStatus };
