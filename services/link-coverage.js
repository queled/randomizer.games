const { QUALIFIER_PHASE } = require('./tournament-autolink');

/**
 * How many played matches of each tournament have their races linked, for the admin
 * list of tournaments. A played match is a completed match between two named players,
 * forfeits (start.gg "DQ") left out: they never have a race.
 *
 * status: complete (every played match linked), partial, none (no race at all: a game
 * not raced on racetime.gg), empty (no played match yet).
 */

const STARTGG_COMPLETED = 3;
const DQ_SCORE = /\bDQ\b/i;

function isNamed(name) {
  return !!name && name !== 'TBD';
}

function coverageStatus({ playedMatches, linkedMatches, races }) {
  if (!playedMatches) return 'empty';
  if (linkedMatches === playedMatches) return 'complete';
  if (!linkedMatches && !races) return 'none';
  return 'partial';
}

/**
 * @param {Object} params
 * @param {Array} params.tournaments - lean tournaments with _id, startggId and, for
 *   start.gg, matches (state, displayScore, raceUrl, raceUrls, startggSetId, player names)
 * @returns {Map<string, Object>} tournament id -> coverage
 */
async function computeLinkCoverage({ tournaments, Match, Race }) {
  const ids = tournaments.map((t) => t._id);
  const [races, challongeMatches] = await Promise.all([
    Race.find({ tournamentId: { $in: ids } })
      .select('tournamentId startggSetId matchId tiebreak tournamentPhase')
      .lean(),
    Match.find({ tournamentId: { $in: ids }, state: 'complete' })
      .select('tournamentId raceUrl player1Name player2Name')
      .lean()
  ]);

  const racesByTournament = new Map();
  for (const race of races) {
    const key = String(race.tournamentId);
    if (!racesByTournament.has(key)) racesByTournament.set(key, []);
    racesByTournament.get(key).push(race);
  }
  const challongeByTournament = new Map();
  for (const match of challongeMatches) {
    const key = String(match.tournamentId);
    if (!challongeByTournament.has(key)) challongeByTournament.set(key, []);
    challongeByTournament.get(key).push(match);
  }

  const coverage = new Map();
  for (const tournament of tournaments) {
    const key = String(tournament._id);
    const tournamentRaces = racesByTournament.get(key) || [];
    const linkedSets = new Set(tournamentRaces.map((r) => r.startggSetId).filter(Boolean));
    const linkedMatchIds = new Set(tournamentRaces.map((r) => r.matchId && String(r.matchId)).filter(Boolean));

    let playedMatches = 0;
    let linkedMatches = 0;
    if (tournament.startggId) {
      for (const match of tournament.matches || []) {
        if (Number(match.state) !== STARTGG_COMPLETED || DQ_SCORE.test(match.displayScore || '')) continue;
        if (!isNamed(match.player1?.name) || !isNamed(match.player2?.name)) continue;
        playedMatches++;
        if (match.raceUrl || match.raceUrls?.length || linkedSets.has(match.startggSetId)) linkedMatches++;
      }
    } else {
      for (const match of challongeByTournament.get(key) || []) {
        if (!isNamed(match.player1Name) || !isNamed(match.player2Name)) continue;
        playedMatches++;
        if (match.raceUrl || linkedMatchIds.has(String(match._id))) linkedMatches++;
      }
    }

    const counts = {
      playedMatches,
      linkedMatches,
      races: tournamentRaces.length,
      qualifierRaces: tournamentRaces.filter((r) => !r.startggSetId && !r.matchId && r.tournamentPhase === QUALIFIER_PHASE).length,
      tiebreakRaces: tournamentRaces.filter((r) => r.tiebreak).length,
      // Attached to the tournament but to no match, qualifier or tie-break: to check by hand
      orphanRaces: tournamentRaces.filter((r) => !r.startggSetId && !r.matchId && !r.tiebreak && r.tournamentPhase !== QUALIFIER_PHASE).length
    };
    coverage.set(key, {
      ...counts,
      missingMatches: playedMatches - linkedMatches,
      percent: playedMatches ? Math.floor((100 * linkedMatches) / playedMatches) : null,
      status: coverageStatus(counts)
    });
  }
  return coverage;
}

// Totals over the tournaments raced on racetime.gg ("none" ones left out)
function summarizeCoverage(coverage) {
  const summary = { playedMatches: 0, linkedMatches: 0, orphanRaces: 0, partial: 0, complete: 0, none: 0 };
  for (const entry of coverage.values()) {
    if (entry.status in summary) summary[entry.status]++;
    summary.orphanRaces += entry.orphanRaces;
    if (entry.status === 'none') continue;
    summary.playedMatches += entry.playedMatches;
    summary.linkedMatches += entry.linkedMatches;
  }
  summary.percent = summary.playedMatches
    ? Math.floor((1000 * summary.linkedMatches) / summary.playedMatches) / 10
    : null;
  return summary;
}

module.exports = { computeLinkCoverage, summarizeCoverage };
