/**
 * Matches of a tournament run on Mido's House alone (no start.gg or Challonge bracket),
 * rebuilt from the races of the event (scripts/sync-midos-events.js).
 *
 * Mido's House gives each race a phase ("Swiss", "Top 8"...) and a round ("Round 3",
 * "Semifinal", or the group of a group stage). The races of a pair in a round make one
 * match (a best of three is three races), its winner the side that won more of them.
 */

const TIEBREAK_RE = /\btie[\s_-]?break(?:er)?s?\b/i;

const kindOf = bracketType => String(bracketType || '').toLowerCase().replace(/[\s_]+/g, '');
const isElimination = kind => kind === 'singleelimination' || kind === 'doubleelimination';

// Group a tie-break settles: "A tie breaker" → "A", "1 Tiebreaker" → "1"
function tiebreakGroup(label) {
  return String(label || '').replace(TIEBREAK_RE, '').trim() || null;
}

/**
 * Round number and group of a race, from its round label and the phase's config:
 * - round robin: the label is the group, every match in round 1;
 * - Swiss: "Round 3" → 3;
 * - elimination: `rounds`, labels from the first round to the final (array), or
 *   label → number (object; losers rounds negative, -1 first); `thirdPlace`, the label of
 *   the third place match, played in the final's round as on start.gg.
 * @returns { round, group, thirdPlace } or null when the label is not one of the phase's
 */
function roundOf(phase, label) {
  const kind = kindOf(phase.bracketType);
  const text = String(label || '').trim();
  if (kind === 'roundrobin') return text ? { round: 1, group: text, thirdPlace: false } : null;
  if (kind === 'swiss') {
    const n = Number(text.match(/(\d+)\s*$/)?.[1]);
    return Number.isInteger(n) && n > 0 ? { round: n, group: null, thirdPlace: false } : null;
  }
  const rounds = phase.rounds || [];
  if (phase.thirdPlace && text === phase.thirdPlace && Array.isArray(rounds)) {
    return { round: rounds.length, group: null, thirdPlace: true };
  }
  const round = Array.isArray(rounds) ? rounds.indexOf(text) + 1 : rounds[text];
  return round ? { round, group: null, thirdPlace: false } : null;
}

/**
 * Side that won more games, once the games left to play (no `doneAt`) can no longer
 * change it; null when none did or both won as many.
 */
function seriesWinner(games) {
  const wins = new Map();
  for (const g of games) if (g.winner) wins.set(g.winner, (wins.get(g.winner) || 0) + 1);
  const [first, second] = [...wins].sort((a, b) => b[1] - a[1]);
  const left = games.filter(g => !g.doneAt).length;
  return first && first[1] > (second ? second[1] : 0) + left ? first[0] : null;
}

/**
 * Elimination matches left without a result (forfeit, no room) whose winner the bracket
 * shows: of the two sides, the only one playing a later round on the same side of the
 * bracket (winners rounds positive, losers rounds negative).
 * Fills `winner` and `walkover` on those matches.
 */
function inferWalkovers(matches, phases) {
  const kinds = new Map(phases.map(p => [p.name, kindOf(p.bracketType)]));
  for (const m of matches) {
    if (m.winner || !isElimination(kinds.get(m.phase)) || m.sides.length !== 2) continue;
    const later = matches.filter(o => o.phase === m.phase && Math.sign(o.round) === Math.sign(m.round)
      && Math.abs(o.round) > Math.abs(m.round));
    const going = m.sides.filter(side => later.some(o => o.sides.includes(side)));
    if (going.length === 1) {
      m.winner = going[0];
      m.walkover = true;
    }
  }
  return matches;
}

/**
 * Matches of an elimination phase in bracket order: the two matches feeding a match sit
 * next to each other, in the order of its sides, from the final back to the first round.
 * The third place match comes after the final. The tournament page keeps that order
 * within a round to draw the bracket.
 */
function orderBracket(matches) {
  const byStart = (a, b) => (a.thirdPlace ? 1 : 0) - (b.thirdPlace ? 1 : 0)
    || (a.startAt || Infinity) - (b.startAt || Infinity);
  const ordered = [];
  for (const sign of [1, -1]) {
    const rounds = [...new Set(matches.map(m => m.round).filter(r => Math.sign(r) === sign))]
      .sort((a, b) => Math.abs(b) - Math.abs(a));
    let next = [];
    const placed = [];
    for (const round of rounds) {
      const left = matches.filter(m => m.round === round).sort(byStart);
      const list = [];
      for (const m of next.filter(x => !x.thirdPlace)) {
        for (const side of m.sides) {
          const i = left.findIndex(o => o.sides.includes(side));
          if (i >= 0) list.push(...left.splice(i, 1));
        }
      }
      list.push(...left);
      placed.unshift(list);
      next = list;
    }
    ordered.push(...placed.flat());
  }
  return ordered;
}

/**
 * Matches of the rounds of a single elimination phase that Mido's House has not paired
 * yet, as start.gg shows them: each fed by two matches of the round before (in bracket
 * order), with their winners once known, TBD otherwise.
 * @param stored matches of the phase in the stored shape, in bracket order
 * @param roundCount rounds of the phase, the final included
 */
function pendingRounds(stored, roundCount) {
  const added = [];
  let round = Math.max(0, ...stored.map(m => m.round));
  let previous = stored.filter(m => m.round === round);
  const winnerOf = m => {
    const side = m && m.winnerId != null && [m.player1, m.player2].find(s => s && String(s.startggEntrantId) === String(m.winnerId));
    return side ? { startggEntrantId: side.startggEntrantId, name: side.name } : { name: 'TBD' };
  };
  while (previous.length && round < roundCount) {
    round++;
    const next = [];
    for (let i = 0; i < previous.length; i += 2) {
      next.push({
        round, completedAt: null, state: 1, phase: previous[i].phase, phaseGroup: null,
        raceUrl: null, raceUrls: [], player1: winnerOf(previous[i]), player2: winnerOf(previous[i + 1]), winnerId: null
      });
    }
    added.push(...next);
    previous = next;
  }
  return added;
}

module.exports = { TIEBREAK_RE, kindOf, isElimination, tiebreakGroup, roundOf, seriesWinner, inferWalkovers, orderBracket, pendingRounds };
