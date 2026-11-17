/**
 * A tournament already stored from another source (its Challonge bracket, its start.gg
 * event, its Mido's House reconstruction) is not imported a second time: same players
 * around the same dates means the same tournament.
 */

const playerKey = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Days around the start date where an event with the same players is the same tournament
const DATE_WINDOW_DAYS = 45;
// Below this many players, two brackets share players by chance
const MIN_PLAYERS = 4;

// Same field (sizes within 70 %) and at least 80 % of the smaller field in both
function isSamePlayerField(namesA, namesB) {
  const a = new Set(namesA.map(playerKey).filter(Boolean));
  const b = new Set(namesB.map(playerKey).filter(Boolean));
  const smaller = Math.min(a.size, b.size);
  if (smaller < MIN_PLAYERS || smaller / Math.max(a.size, b.size) < 0.7) return false;
  const shared = [...a].filter(name => b.has(name)).length;
  return shared / smaller >= 0.8;
}

/**
 * Name of a stored tournament with the same players around `startDate`, or null.
 * `exclude`: a Mongo filter leaving out the tournament being imported (and its group).
 */
async function findProbableDuplicate(Tournament, { playerNames, startDate = null, exclude = {} }) {
  if (new Set(playerNames.map(playerKey).filter(Boolean)).size < MIN_PLAYERS) return null;

  const query = { ...exclude };
  const time = startDate ? new Date(startDate).getTime() : NaN;
  if (Number.isFinite(time)) {
    const windowMs = DATE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    query.startDate = { $gte: new Date(time - windowMs), $lte: new Date(time + windowMs) };
  }

  for (const existing of await Tournament.find(query).select('name participants.name').lean()) {
    if (isSamePlayerField(playerNames, (existing.participants || []).map(p => p.name))) return existing.name;
  }
  return null;
}

// A Challonge bracket is compared with tournaments from other sources only: two
// brackets of a weekly Challonge series share their players without being the same event
const NOT_CHALLONGE = { challongeId: null, 'challongeBrackets.0': { $exists: false } };

// A start.gg event is compared with tournaments from other sources and with the other
// events of its own tournament, never with another start.gg tournament (weekly series too)
function startggExclusion(eventId, tournamentId) {
  return { startggId: { $ne: eventId }, $or: [{ startggId: null }, { startggTournamentId: tournamentId }] };
}

// Name of a tournament from another source with the same players and dates, for a Challonge bracket not stored yet
async function findChallongeDuplicate(Tournament, { tournamentData, participants }) {
  const stored = await Tournament.exists({ $or: [{ challongeId: tournamentData.id }, { 'challongeBrackets.challongeId': tournamentData.id }] });
  if (stored) return null;
  return findProbableDuplicate(Tournament, {
    playerNames: participants.map(p => p.displayName || p.name),
    startDate: tournamentData.startedAt || tournamentData.completedAt,
    exclude: NOT_CHALLONGE
  });
}

module.exports = { playerKey, isSamePlayerField, findProbableDuplicate, findChallongeDuplicate, NOT_CHALLONGE, startggExclusion };
