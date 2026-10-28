/**
 * Final ranks of a finished elimination bracket, for Challonge tournaments the organizer
 * never finalized ("awaiting_review": every match played, no `final_rank`).
 * Ranked as Challonge does: players knocked out at the same stage tie
 * (single elimination 1, 2, 3, 3, 5...; double elimination 1, 2, 3, 4, 5, 5, 7...).
 */

const { computeProvisionalRanks, strongestFirst } = require('./provisional-ranks');

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

const GROUP_PHASE = 'Groups';

/**
 * Ranks of a Challonge tournament still running, from the matches played so far, as start.gg
 * events get them (helpers/provisional-ranks.js): its matches are read in the start.gg shape.
 * A group stage is a round robin phase before the final bracket; grouped brackets keep their phase.
 * @returns Map participant challongeId → rank, or null when nothing was played
 */
function computeChallongeProvisionalRanks({ tournamentType, challongeBrackets, phases: storedPhases, participants, matches }) {
  // Group stage matches name the players by group ids, not stored: the sync writes their names
  const idByName = new Map();
  for (const p of participants || []) {
    for (const name of [p.displayName, p.name]) if (name && !idByName.has(name)) idByName.set(name, String(p.challongeId));
  }
  const known = new Set((participants || []).map(p => String(p.challongeId)));
  const entrant = (id, name) => (id != null && known.has(String(id)) ? String(id) : idByName.get(name) || null);

  const shaped = (matches || []).map(m => {
    const player1 = entrant(m.player1Id, m.player1Name);
    const player2 = entrant(m.player2Id, m.player2Name);
    const winner = m.state === 'complete' && m.winnerId != null
      ? (String(m.winnerId) === String(m.player1Id) ? player1 : String(m.winnerId) === String(m.player2Id) ? player2 : null)
      : null;
    return {
      phase: m.groupId != null ? GROUP_PHASE : m.phase || '',
      round: m.round,
      winnerId: winner,
      player1: { startggEntrantId: player1 },
      player2: { startggEntrantId: player2 }
    };
  });
  if (!shaped.some(m => m.winnerId != null)) return null;

  if (!challongeBrackets?.length) {
    const phases = [{ name: '', bracketType: tournamentType, phaseOrder: 2 }];
    if (shaped.some(m => m.phase === GROUP_PHASE)) phases.push({ name: GROUP_PHASE, bracketType: 'round robin', phaseOrder: 1 });
    return computeProvisionalRanks(shaped, phases);
  }
  return computeProvisionalRanks(...parallelBracketPhases(shaped, storedPhases || []));
}

/**
 * Grouped brackets (services/challonge-bracket-groups.js) are often played side by side by
 * different players (Upper, Middle, Lower), with no stage feeding them: the provisional ranks
 * would place the last one stored first, as a later start.gg phase. Strongest last when their
 * names order them, else one bracket level, tied at the round reached. Brackets sharing players
 * follow one another and keep their order.
 */
function parallelBracketPhases(matches, phases) {
  const playersOf = new Map(phases.map(p => [p.name, new Set()]));
  for (const m of matches) {
    for (const side of [m.player1, m.player2]) if (side.startggEntrantId && playersOf.has(m.phase)) playersOf.get(m.phase).add(side.startggEntrantId);
  }
  const names = phases.map(p => p.name);
  const disjoint = names.every(a => names.every(b => a === b || ![...playersOf.get(a)].some(id => playersOf.get(b).has(id))));
  if (!disjoint || names.length < 2) return [matches, phases];

  const ordered = strongestFirst(names, name => name, () => 0);
  if (ordered) {
    return [matches, ordered.reverse().map((name, i) => ({ ...phases.find(p => p.name === name), phaseOrder: i + 1 }))];
  }
  const types = [...new Set(phases.map(p => p.bracketType).filter(Boolean))];
  return [matches.map(m => ({ ...m, phase: '' })), [{ name: '', bracketType: types.length === 1 ? types[0] : null, phaseOrder: 1 }]];
}

module.exports = {
  computeEliminationRanks,
  computeChallongeProvisionalRanks,
  fillMissingFinalRanks
};
