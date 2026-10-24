/**
 * Ranks of an ongoing start.gg event, from the sets played so far.
 *
 * While an event runs, start.gg places each entrant where they would finish if knocked out now
 * (every pool player tied at the same place). Instead:
 * - an entrant who reached a later phase ranks above those still in an earlier one, and the
 *   players of a parallel bracket identified as the stronger one above those of the other;
 * - in a round robin / Swiss phase: more wins first, then fewer losses (Swiss: then the wins of
 *   the opponents met, the Buchholz score);
 * - in an elimination phase: entrants still in first (more wins first), then the eliminated
 *   ones by how far they went (double elimination: out on the second loss); entrants still in
 *   are then told apart by their record in the earlier phases.
 * Tied entrants share their rank (1, 2, 2, 4).
 */

const kindOf = bracketType => String(bracketType || '').toLowerCase().replace(/[\s_]+/g, '');

const sideIds = m => [m.player1?.startggEntrantId, m.player2?.startggEntrantId]
  .map(id => (id == null || id === '' ? null : String(id)));

// Parallel brackets named by level, strongest first (as on the tournament page)
const BRACKET_LEVELS = [
  /\b(upper|gold(en)?|hard|expert|advanced)\b/i,
  /\b(middle|silver|medium|normal|intermediate)\b/i,
  /\b(lower|bronze|easy|beginner|novice)\b/i
];

const allDistinct = values => new Set(values).size === values.length;

/**
 * Parallel brackets from strongest to weakest, when their order is clear: from their names
 * (Gold > Silver > Bronze...), or else from how much their players won before. null otherwise.
 */
function strongestFirst(brackets, nameOf, strengthOf) {
  const levels = brackets.map(b => BRACKET_LEVELS.findIndex(re => re.test(nameOf(b) || '')));
  const strengths = brackets.map(strengthOf);
  // Higher score, stronger bracket
  const scores = !levels.includes(-1) && allDistinct(levels) ? levels.map(level => -level)
    : allDistinct(strengths) ? strengths
      : null;
  if (!scores) return null;
  return brackets.map((b, i) => ({ b, score: scores[i] })).sort((x, y) => y.score - x.score).map(({ b }) => b);
}

/**
 * Tier of each phase: a later phase ranks above an earlier one. Parallel brackets fed by the
 * same phase (e.g. pools → Gold + Silver) hold different players: when their order is clear,
 * from their names or else from how much their players won in the feeding phase, the stronger
 * one ranks above the other whatever their phaseOrder, so that the last of Gold stays above the
 * first of Silver. When it is not, they share a tier and their players are ranked together.
 * @returns Map phase name → tier
 */
function phaseTiers(order, matches) {
  const tiers = new Map(order.map((name, i) => [name, i]));
  const playersOf = new Map(order.map(name => [name, new Set()]));
  const wins = new Map(); // `${phase}|${entrantId}` → wins
  for (const m of matches) {
    const name = m.phase || '';
    for (const id of sideIds(m)) {
      if (!id) continue;
      playersOf.get(name).add(id);
      if (id === String(m.winnerId)) wins.set(`${name}|${id}`, (wins.get(`${name}|${id}`) || 0) + 1);
    }
  }

  // Each phase is fed by the earlier phase sharing the most players with it
  const children = new Map();
  order.forEach((name, i) => {
    let parent = null;
    let best = 0;
    for (const earlier of order.slice(0, i)) {
      const shared = [...playersOf.get(name)].filter(id => playersOf.get(earlier).has(id)).length;
      if (shared > best) { best = shared; parent = earlier; }
    }
    if (parent) children.set(parent, [...(children.get(parent) || []), name]);
  });

  for (const [parent, kids] of children) {
    // Brackets sharing players follow one another (e.g. a top 8 after the main bracket): not parallel
    const parallel = kids.filter(name => kids.every(other => other === name
      || ![...playersOf.get(name)].some(id => playersOf.get(other).has(id))));
    if (parallel.length < 2) continue;

    const ordered = strongestFirst(parallel, name => name, name => {
      const players = [...playersOf.get(name)];
      return players.reduce((sum, id) => sum + (wins.get(`${parent}|${id}`) || 0), 0) / players.length;
    });
    const slots = parallel.map(name => tiers.get(name)).sort((a, b) => a - b);
    if (!ordered) {
      parallel.forEach(name => tiers.set(name, slots[0]));
      continue;
    }
    // The same slots, weakest bracket in the lowest one
    ordered.reverse().forEach((name, i) => tiers.set(name, slots[i]));
  }
  return tiers;
}

/**
 * @param matches sets in the stored shape ({ phase, round, winnerId, player1/2.startggEntrantId })
 * @param phases [{ name, bracketType, phaseOrder }]
 * @returns Map entrantId → rank
 */
function computeProvisionalRanks(matches = [], phases = []) {
  const declared = [...phases].sort((a, b) => (a.phaseOrder || 0) - (b.phaseOrder || 0)).map(p => p.name);
  const order = [...declared];
  for (const m of matches) if (!order.includes(m.phase || '')) order.push(m.phase || '');
  const tiers = phaseTiers(order, matches);
  const tierOf = name => tiers.get(name || '');

  // Phase kind, from start.gg or from the sets when the phase is not declared
  const kinds = new Map();
  for (const name of order) {
    const phase = phases.find(p => p.name === name);
    let kind = phase ? kindOf(phase.bracketType) : '';
    if (!kind) {
      const list = matches.filter(m => (m.phase || '') === name);
      const losses = new Map();
      list.forEach(m => m.winnerId != null && sideIds(m).forEach(id => {
        if (id && id !== String(m.winnerId)) losses.set(id, (losses.get(id) || 0) + 1);
      }));
      kind = list.some(m => (m.round || 0) < 0) ? 'doubleelimination'
        : [...losses.values()].some(n => n > 1) ? 'roundrobin' : 'singleelimination';
    }
    kinds.set(name, kind);
  }

  // Each entrant's furthest phase, and their results there
  const stats = new Map();
  for (const m of matches) {
    const tier = tierOf(m.phase);
    for (const id of sideIds(m)) {
      if (!id) continue;
      const s = stats.get(id);
      if (!s || tier > s.tier) stats.set(id, { tier, phase: m.phase || '', wins: 0, losses: 0, out: 0, allWins: 0, allLosses: 0, buchholz: 0 });
    }
  }
  for (const m of matches) {
    if (m.winnerId == null) continue;
    const kind = kinds.get(m.phase || '');
    for (const id of sideIds(m)) {
      const s = id && stats.get(id);
      if (!s) continue;
      if (id === String(m.winnerId)) s.allWins += 1;
      else s.allLosses += 1;
      if (s.phase !== (m.phase || '')) continue;
      if (id === String(m.winnerId)) { s.wins += 1; continue; }
      s.losses += 1;
      const round = m.round || 0;
      // How far the entrant went when knocked out (losers rounds count back from -1, grand finals last)
      if (kind === 'singleelimination') s.out = Math.max(s.out, Math.abs(round) || 1);
      else if (kind === 'doubleelimination' && s.losses >= 2) s.out = round > 0 ? 1000 + round : Math.abs(round);
    }
  }

  // Swiss: the wins in the phase of each opponent met there
  const phaseWins = new Map(); // `${phase}|${entrantId}` → wins
  for (const m of matches) {
    if (m.winnerId != null) phaseWins.set(`${m.phase || ''}|${m.winnerId}`, (phaseWins.get(`${m.phase || ''}|${m.winnerId}`) || 0) + 1);
  }
  for (const m of matches) {
    const phase = m.phase || '';
    if (m.winnerId == null || kinds.get(phase) !== 'swiss') continue;
    const [p1, p2] = sideIds(m);
    if (!p1 || !p2) continue;
    [[p1, p2], [p2, p1]].forEach(([id, opponent]) => {
      const s = stats.get(id);
      if (s && s.phase === phase) s.buchholz += phaseWins.get(`${phase}|${opponent}`) || 0;
    });
  }

  const keyOf = s => {
    const kind = kinds.get(s.phase);
    const elimination = kind === 'singleelimination' || kind === 'doubleelimination';
    const stillIn = elimination && !s.out;
    // Higher first: phase, still in, how far, wins, fewer losses, Buchholz, then the whole record of those still in
    return [s.tier, stillIn ? 1 : 0, s.out, s.wins, -s.losses, s.buchholz, stillIn ? s.allWins : 0, stillIn ? -s.allLosses : 0];
  };
  const compare = (a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i];
    return 0;
  };

  const sorted = [...stats.entries()].sort((a, b) => compare(a[1], b[1]));
  const ranks = new Map();
  sorted.forEach(([id, s], i) => {
    const prev = sorted[i - 1];
    ranks.set(id, prev && compare(prev[1], s) === 0 ? ranks.get(prev[0]) : i + 1);
  });
  return ranks;
}

module.exports = { computeProvisionalRanks, strongestFirst };
