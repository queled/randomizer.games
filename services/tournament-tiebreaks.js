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

// The pools (and phases) every entrant played in
function sharedPools(entrantIds, poolsByUser) {
  let shared = null;
  for (const userId of entrantIds) {
    const pools = poolsByUser.get(userId);
    if (!pools) return [];
    shared = shared ? new Set([...shared].filter((key) => pools.has(key))) : new Set(pools);
  }
  return shared ? [...shared] : [];
}

// First and last race the entrants played in a pool
function entrantsSpan(entrantIds, userSpans) {
  const spans = entrantIds.map((userId) => userSpans.get(userId)).filter(Boolean);
  return {
    min: Math.min(...spans.map((span) => span.min)),
    max: Math.max(...spans.map((span) => span.max))
  };
}

/**
 * The pool a tie-break settles, among the ones its players shared: the group its info
 * names, else the one they were playing on its date, else the last one they finished
 * before it, as long as they played another pool afterwards.
 */
function pickPool(keys, race, entrantIds, poolSpans) {
  const namedGroup = String(race.info || '').match(INFO_GROUP);
  if (namedGroup) {
    // The group the room names, if any, must be the players' one
    keys = keys.filter((key) => String(Number(namedGroup[1])) === String(JSON.parse(key)[1]).trim());
  }
  if (keys.length <= 1) return keys[0] || null;

  const startedAt = new Date(race.startedAt).getTime();
  if (!Number.isFinite(startedAt)) return null;
  const spans = new Map(keys.map((key) => [key, entrantsSpan(entrantIds, poolSpans.get(key))]));
  const ongoing = keys.filter((key) => spans.get(key).min <= startedAt && startedAt <= spans.get(key).max);
  if (ongoing.length) return ongoing.length === 1 ? ongoing[0] : null;

  if (!keys.some((key) => spans.get(key).min > startedAt)) return null;
  const over = keys
    .filter((key) => spans.get(key).max < startedAt)
    .sort((a, b) => spans.get(b).max - spans.get(a).max);
  return over[0] || null;
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
  // pool -> userId -> first and last race of that player in it
  const poolSpans = new Map();
  for (const race of linkedRaces) {
    const key = JSON.stringify([race.tournamentPhase, race.tournamentPool || null]);
    const startedAt = new Date(race.startedAt).getTime();
    if (!poolSpans.has(key)) poolSpans.set(key, new Map());
    for (const entrant of race.entrants || []) {
      if (!entrant.userId) continue;
      if (Number.isFinite(startedAt)) {
        const span = poolSpans.get(key).get(entrant.userId) || { min: Infinity, max: -Infinity };
        poolSpans.get(key).set(entrant.userId, { min: Math.min(span.min, startedAt), max: Math.max(span.max, startedAt) });
      }
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
  }).select('url goal info startedAt entrants.userId entrants.userName').lean();

  const proposals = [];
  for (const race of candidates) {
    if (goals.size && !goals.has(normalizeGoal(race.goal))) continue;
    const entrantIds = (race.entrants || []).map((entrant) => entrant.userId);
    if (entrantIds.length < 2 || entrantIds.some((id) => !id)) continue;
    const pool = pickPool(sharedPools(entrantIds, poolsByUser), race, entrantIds, poolSpans);
    if (!pool) continue;
    const [phase, poolName] = JSON.parse(pool);
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
