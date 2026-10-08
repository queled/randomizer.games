/**
 * Final ranks of a finished elimination bracket, for Challonge tournaments the organizer
 * never finalized ("awaiting_review": every match played, no `final_rank`).
 * Ranked as Challonge does: players knocked out at the same stage tie
 * (single elimination 1, 2, 3, 3, 5...; double elimination 1, 2, 3, 4, 5, 5, 7...).
 */

const FINISHED_STATES = ['awaiting_review', 'complete', 'completed', 'ended'];

function isComplete(match) {
  return match?.state === 'complete' && match.winnerId != null && match.loserId != null;
}

/**
 * Challonge participant id → final rank, or null when the bracket is not a finished
 * single or double elimination. After a group stage, only the players of the final
 * bracket are ranked.
 */
function computeEliminationRanks({ tournamentType, matches: allMatches }) {
  const type = String(tournamentType || '').toLowerCase().replace(/_/g, ' ');
  const isDouble = type === 'double elimination';
  if (!isDouble && type !== 'single elimination') return null;
  const matches = (allMatches || []).filter((m) => m.groupId == null);
  if (!matches.length) return null;

  const maxRound = Math.max(...matches.map((m) => Number(m.round) || 0));
  // An unplayed bracket reset is the only match a finished double elimination may leave
  const played = matches.filter((m) => !(isDouble && Number(m.round) === maxRound && !isComplete(m)));
  if (!played.length || played.some((m) => !isComplete(m))) return null;

  // Stage at which each loss knocks a player out: the later, the better the rank
  const lastRound = played.filter((m) => Number(m.round) === maxRound);
  let finalMatch;
  let bronzeMatch = null;
  if (isDouble) {
    // The grand final, or its reset when played: the last winners side match
    finalMatch = played
      .filter((m) => Number(m.round) > 0)
      .sort((a, b) => (Number(a.round) - Number(b.round)) || (new Date(a.completedAt || 0) - new Date(b.completedAt || 0)))
      .pop();
  } else {
    if (lastRound.length > 2) return null;
    // A third place match is played by the two semi-final losers
    const semiLosers = new Set(played.filter((m) => Number(m.round) === maxRound - 1).map((m) => String(m.loserId)));
    bronzeMatch = lastRound.length === 2
      ? lastRound.find((m) => semiLosers.has(String(m.winnerId)) && semiLosers.has(String(m.loserId)))
      : null;
    if (lastRound.length === 2 && !bronzeMatch) return null;
    finalMatch = lastRound.find((m) => m !== bronzeMatch);
  }

  const stageOfLoss = (match) => {
    const round = Number(match.round) || 0;
    if (match === finalMatch) return Number.MAX_SAFE_INTEGER;
    // A winners side loss drops to the losers bracket (or is won back in the reset)
    if (isDouble) return round < 0 ? -round : null;
    return round;
  };

  const stageByPlayer = new Map();
  for (const match of played) {
    for (const id of [match.winnerId, match.loserId]) {
      if (!stageByPlayer.has(String(id))) stageByPlayer.set(String(id), Infinity);
    }
  }
  for (const match of played) {
    const stage = stageOfLoss(match);
    if (stage === null) continue;
    const key = String(match.loserId);
    stageByPlayer.set(key, Math.min(stageByPlayer.get(key), stage));
  }
  // Semi-final losers are split by their third place match
  if (bronzeMatch) {
    stageByPlayer.set(String(bronzeMatch.winnerId), maxRound - 0.25);
    stageByPlayer.set(String(bronzeMatch.loserId), maxRound - 0.5);
  }

  const champions = [...stageByPlayer.values()].filter((stage) => stage === Infinity).length;
  if (champions !== 1) return null;

  const stages = [...stageByPlayer.values()];
  const ranks = new Map();
  for (const [id, stage] of stageByPlayer) {
    ranks.set(id, 1 + stages.filter((other) => other > stage).length);
  }
  return ranks;
}

/**
 * Participants with the ranks of the finished bracket, when Challonge gives none.
 * Returns the same array, untouched when ranks are known or cannot be computed.
 */
function fillMissingFinalRanks({ tournamentData, participants, matches }) {
  if (!FINISHED_STATES.includes(String(tournamentData?.state || '').toLowerCase())) return participants;
  if (!Array.isArray(participants) || participants.some((p) => p.finalRank != null)) return participants;

  const ranks = computeEliminationRanks({ tournamentType: tournamentData.tournamentType, matches });
  if (!ranks) return participants;
  for (const participant of participants) {
    const rank = ranks.get(String(participant.challongeId));
    if (rank) participant.finalRank = rank;
  }
  return participants;
}

module.exports = {
  computeEliminationRanks,
  fillMissingFinalRanks
};
