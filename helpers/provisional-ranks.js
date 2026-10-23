/**
 * Ranks of an ongoing start.gg event, from the sets played so far.
 *
 * While an event runs, start.gg places each entrant where they would finish if knocked out now
 * (every pool player tied at the same place). Instead:
 * - an entrant who reached a later phase ranks above those still in an earlier one;
 * - in a round robin / Swiss phase: more wins first, then fewer losses;
 * - in an elimination phase: entrants still in first (more wins first), then the eliminated
 *   ones by how far they went (double elimination: out on the second loss); entrants still in
 *   are then told apart by their record in the earlier phases.
 * Tied entrants share their rank (1, 2, 2, 4).
 */

const kindOf = bracketType => String(bracketType || '').toLowerCase().replace(/[\s_]+/g, '');

const sideIds = m => [m.player1?.startggEntrantId, m.player2?.startggEntrantId]
  .map(id => (id == null || id === '' ? null : String(id)));

/**
 * @param matches sets in the stored shape ({ phase, round, winnerId, player1/2.startggEntrantId })
 * @param phases [{ name, bracketType, phaseOrder }]
 * @returns Map entrantId → rank
 */
function computeProvisionalRanks(matches = [], phases = []) {
  const declared = [...phases].sort((a, b) => (a.phaseOrder || 0) - (b.phaseOrder || 0)).map(p => p.name);
  const order = [...declared];
  for (const m of matches) if (!order.includes(m.phase || '')) order.push(m.phase || '');
  const tierOf = name => order.indexOf(name || '');

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
      if (!s || tier > s.tier) stats.set(id, { tier, wins: 0, losses: 0, out: 0, allWins: 0, allLosses: 0 });
    }
  }
  for (const m of matches) {
    if (m.winnerId == null) continue;
    const tier = tierOf(m.phase);
    const kind = kinds.get(m.phase || '');
    for (const id of sideIds(m)) {
      const s = id && stats.get(id);
      if (!s) continue;
      if (id === String(m.winnerId)) s.allWins += 1;
      else s.allLosses += 1;
      if (s.tier !== tier) continue;
      if (id === String(m.winnerId)) { s.wins += 1; continue; }
      s.losses += 1;
      const round = m.round || 0;
      // How far the entrant went when knocked out (losers rounds count back from -1, grand finals last)
      if (kind === 'singleelimination') s.out = Math.max(s.out, Math.abs(round) || 1);
      else if (kind === 'doubleelimination' && s.losses >= 2) s.out = round > 0 ? 1000 + round : Math.abs(round);
    }
  }

  const keyOf = s => {
    const kind = kinds.get(order[s.tier]);
    const elimination = kind === 'singleelimination' || kind === 'doubleelimination';
    const stillIn = elimination && !s.out;
    // Higher first: phase, still in, how far, wins, fewer losses, then the whole record of those still in
    return [s.tier, stillIn ? 1 : 0, s.out, s.wins, -s.losses, stillIn ? s.allWins : 0, stillIn ? -s.allLosses : 0];
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

module.exports = { computeProvisionalRanks };
