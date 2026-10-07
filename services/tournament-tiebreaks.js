const { collectCandidateCategories } = require('./tournament-autolink');

// Tie-breaks are rooms opened by hand when players finish a group level: neither a
// start.gg set nor a race scheduled on Mido's House. The room's info names them.
const TIEBREAK_INFO = /tie[\s_-]?break/i;
// "Group 7 Tiebreakers", "Tie Break Groupe 1", "Tie Breaker group 4"
const INFO_GROUP = /\b(?:group|groupe|grupo|gruppe|gruppo|pool|poule)\s*#?\s*(\d+)/i;
const PADDING_MS = 14 * 24 * 60 * 60 * 1000;

function normalizeGoal(value) {
  return String(value || '').trim().toLowerCase();
}

// The pool (and phase) every entrant played in: a tie-break settles one group
function commonPool(entrantIds, poolsByUser) {
  let shared = null;
  for (const userId of entrantIds) {
    const pools = poolsByUser.get(userId);
    if (!pools) return null;
    shared = shared ? new Set([...shared].filter((key) => pools.has(key))) : new Set(pools);
  }
  return shared && shared.size === 1 ? [...shared][0] : null;
}

/**
 * Tie-break rooms of a tournament: unlinked races of its category and dates whose info
 * says tie-break, with the goal of its races, between players who all played the same
 * pool of it. Proposals carry the phase and pool of those players.
 */
async function findTiebreakRaces({ tournament, Race }) {
  const linkedRaces = await Race.find({
    tournamentId: tournament._id,
    tournamentPhase: { $exists: true, $nin: [null, 'Qualifications'] },
    tiebreak: { $ne: true }
  }).select('category goal startedAt entrants.userId tournamentPhase tournamentPool').lean();
  if (!linkedRaces.length) return [];

  const poolsByUser = new Map();
  for (const race of linkedRaces) {
    const key = JSON.stringify([race.tournamentPhase, race.tournamentPool || null]);
    for (const entrant of race.entrants || []) {
      if (!entrant.userId) continue;
      if (!poolsByUser.has(entrant.userId)) poolsByUser.set(entrant.userId, new Set());
      poolsByUser.get(entrant.userId).add(key);
    }
  }

  const goals = new Set(linkedRaces.map((race) => normalizeGoal(race.goal)).filter(Boolean));
  const categories = collectCandidateCategories(tournament, linkedRaces);
  if (!categories.length) return [];

  const starts = linkedRaces.map((race) => new Date(race.startedAt).getTime()).filter(Number.isFinite);
  if (tournament.startDate) starts.push(new Date(tournament.startDate).getTime());
  const minDate = new Date(Math.min(...starts));
  const maxDate = new Date(Math.max(Date.now(), ...starts) + PADDING_MS);

  const candidates = await Race.find({
    category: { $in: categories },
    tournamentId: null,
    info: TIEBREAK_INFO,
    startedAt: { $gte: minDate, $lte: maxDate }
  }).select('url goal info entrants.userId entrants.userName').lean();

  const proposals = [];
  for (const race of candidates) {
    if (goals.size && !goals.has(normalizeGoal(race.goal))) continue;
    const entrantIds = (race.entrants || []).map((entrant) => entrant.userId);
    if (entrantIds.length < 2 || entrantIds.some((id) => !id)) continue;
    const pool = commonPool(entrantIds, poolsByUser);
    if (!pool) continue;
    const [phase, poolName] = JSON.parse(pool);
    // The group the room names, if any, must be the players' one
    const namedGroup = String(race.info || '').match(INFO_GROUP);
    if (namedGroup && String(Number(namedGroup[1])) !== String(poolName).trim()) continue;
    proposals.push({
      raceId: race._id,
      raceUrl: race.url,
      phase,
      pool: poolName,
      players: (race.entrants || []).map((entrant) => entrant.userName).filter(Boolean).join(' vs ')
    });
  }
  return proposals;
}

async function applyTiebreakRaces({ tournament, proposals, Race }) {
  let linked = 0;
  for (const proposal of proposals) {
    const result = await Race.updateOne(
      { _id: proposal.raceId, tournamentId: null },
      {
        $set: {
          tournamentId: tournament._id,
          tournamentPhase: proposal.phase,
          tournamentPool: proposal.pool,
          matchPlayers: proposal.players,
          tiebreak: true
        }
      }
    );
    linked += result.modifiedCount || 0;
  }
  return linked;
}

module.exports = {
  findTiebreakRaces,
  applyTiebreakRaces
};
