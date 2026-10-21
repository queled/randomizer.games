// Tournaments a player entered (player page): found by racetime account first, by name
// only for participants not linked to an account. Each one with the player's rank,
// team, and win/loss record when the tournament gives no rank (leagues).
const { calculateTournamentStatus } = require('./tournament-status');
const { loadGameLabels, tournamentGameLabel } = require('./game-label');

const STATUS_KEYS = { 'terminé': 'finished', 'en cours': 'ongoing', 'à venir': 'upcoming' };

function normalizeName(name) {
  if (!name) return '';
  return name.toString().toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

const escapeRegex = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function participantQuery({ userId, names }) {
  const or = [];
  if (userId) or.push({ 'participants.racetimeUserId': userId });
  if (names.length) {
    const nameRegex = new RegExp(names.map(n => `^${escapeRegex(n)}$`).join('|'), 'i');
    or.push({ 'participants.racetimeName': nameRegex }, { 'participants.name': nameRegex }, { 'participants.displayName': nameRegex });
  }
  return or.length ? { $or: or } : { _id: null };
}

// A participant linked to a racetime account is that account's, whatever its bracket name
function isPlayerParticipant(part, { userId, normalizedNames }) {
  if (part.racetimeUserId) {
    if (userId) return part.racetimeUserId === userId;
    return normalizedNames.has(normalizeName(part.racetimeName));
  }
  return [part.racetimeName, part.displayName, part.name].some(n => n && normalizedNames.has(normalizeName(n)));
}

const participantLabel = part => part.racetimeName || part.displayName || part.name || null;

// One entrant per team (start.gg co-op) or per participant
function entrantsCount(t) {
  const keys = new Set((t.participants || []).map(p => p.team || p.startggEntrantId || p.challongeId || String(p._id)));
  return keys.size || t.participantsCount || null;
}

/**
 * Rank from the matches when Challonge gives none for a finished tournament (group stage →
 * final bracket): players knocked out before the final bracket tie behind the players who
 * reached it; the others are ordered by bracket progress, then group wins and seed.
 */
function computeRankFromMatches(participants, participant, matches) {
  const wanted = participant.challongeId != null ? String(participant.challongeId) : null;
  if (!wanted) return null;

  const stats = new Map();
  for (const part of participants) {
    if (part.challongeId == null) continue;
    stats.set(String(part.challongeId), { qualified: false, maxFinalRound: 0, finalWins: 0, groupWins: 0, seed: Number.isFinite(part.seed) ? part.seed : 9999 });
  }
  const byName = name => {
    if (!name) return null;
    const part = participants.find(p => p.challongeId != null && (p.name === name || p.displayName === name));
    return part ? stats.get(String(part.challongeId)) : null;
  };

  for (const m of matches) {
    const p1 = m.player1Id != null ? String(m.player1Id) : null;
    const p2 = m.player2Id != null ? String(m.player2Id) : null;
    const s1 = (p1 && stats.get(p1)) || byName(m.player1Name);
    const s2 = (p2 && stats.get(p2)) || byName(m.player2Name);
    const winner = m.winnerId != null ? String(m.winnerId) : null;
    if (m.groupId == null) {
      for (const s of [s1, s2]) {
        if (!s) continue;
        s.qualified = true;
        s.maxFinalRound = Math.max(s.maxFinalRound, Number(m.round) || 0);
      }
      if (winner && s1 && winner === p1) s1.finalWins += 1;
      if (winner && s2 && winner === p2) s2.finalWins += 1;
    } else if (winner) {
      if (s1 && winner === p1) s1.groupWins += 1;
      if (s2 && winner === p2) s2.groupWins += 1;
    }
  }

  const hasRank = p => Number(p.finalRank) > 0;
  const statsOf = p => (p.challongeId != null ? stats.get(String(p.challongeId)) : null);

  if (!stats.get(wanted)?.qualified) {
    const ahead = participants.filter(p => hasRank(p) || statsOf(p)?.qualified).length;
    if (ahead) return ahead + 1;
  }

  const zero = { qualified: false, maxFinalRound: 0, finalWins: 0, groupWins: 0, seed: 9999 };
  const sorted = [...participants].sort((a, b) => {
    if (hasRank(a) || hasRank(b)) {
      if (hasRank(a) && hasRank(b)) return a.finalRank - b.finalRank;
      return hasRank(a) ? -1 : 1;
    }
    const sa = statsOf(a) || zero;
    const sb = statsOf(b) || zero;
    if (sa.qualified !== sb.qualified) return sa.qualified ? -1 : 1;
    return (sb.maxFinalRound - sa.maxFinalRound) || (sb.finalWins - sa.finalWins)
      || (sb.groupWins - sa.groupWins) || (sa.seed - sb.seed);
  });
  const index = sorted.findIndex(p => p.challongeId != null && String(p.challongeId) === wanted);
  return index >= 0 ? index + 1 : null;
}

// Wins and losses of the player's start.gg / Mido's House matches, and their division
function startggRecord(t, participant) {
  const entrantId = participant.startggEntrantId != null ? String(participant.startggEntrantId) : null;
  if (!entrantId) return null;
  let wins = 0;
  let losses = 0;
  const divisions = new Map();
  for (const m of t.matches || []) {
    const side = String(m.player1?.startggEntrantId) === entrantId ? 1
      : String(m.player2?.startggEntrantId) === entrantId ? 2 : 0;
    if (!side || m.winnerId == null) continue;
    if (String(m.winnerId) === entrantId) wins += 1;
    else losses += 1;
    if (m.phaseGroup) divisions.set(m.phaseGroup, (divisions.get(m.phaseGroup) || 0) + 1);
  }
  if (!wins && !losses) return null;
  const division = [...divisions].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  return { wins, losses, division };
}

/**
 * @param userId racetime account of the player, when known
 * @param names the player's name and former names
 */
async function buildPlayerTournaments({ Tournament, Match, userId, names }) {
  const cleanNames = [...new Set(names.filter(Boolean))];
  const owner = { userId, normalizedNames: new Set(cleanNames.map(normalizeName)) };

  const [tournaments, labelFor] = await Promise.all([
    Tournament.find(participantQuery({ userId, names: cleanNames }))
      .select('name gameName gameSlug gameId startDate endDate state status participantsCount participants matches.player1.startggEntrantId matches.player2.startggEntrantId matches.winnerId matches.phaseGroup midosHouse.schedule.startAt game')
      .populate('game', 'id name official.name randomizer')
      .lean(),
    loadGameLabels()
  ]);

  const entries = [];
  for (const t of tournaments) {
    const own = (t.participants || []).filter(p => isPlayerParticipant(p, owner));
    if (!own.length) continue;
    const participant = own.find(p => Number(p.finalRank) > 0) || own[0];
    entries.push({ t, participant, status: STATUS_KEYS[calculateTournamentStatus(t)] || 'ongoing' });
  }

  // Challonge ranks the organizer never finalized are computed from the bracket
  const toCompute = entries.filter(e => e.status === 'finished' && !(Number(e.participant.finalRank) > 0) && e.participant.challongeId != null);
  const matchesByTournament = new Map();
  if (toCompute.length) {
    const matches = await Match.find({ tournamentId: { $in: toCompute.map(e => e.t._id) } })
      .select('tournamentId player1Id player2Id player1Name player2Name winnerId round groupId')
      .lean();
    for (const m of matches) {
      const key = String(m.tournamentId);
      if (!matchesByTournament.has(key)) matchesByTournament.set(key, []);
      matchesByTournament.get(key).push(m);
    }
  }

  return entries.map(({ t, participant, status }) => {
    let rank = Number(participant.finalRank) > 0 ? Number(participant.finalRank) : null;
    let rankComputed = false;
    if (!rank && toCompute.some(e => e.t === t)) {
      rank = computeRankFromMatches(t.participants, participant, matchesByTournament.get(String(t._id)) || []);
      rankComputed = !!rank;
    }

    const team = participant.team
      ? {
        name: participant.team,
        members: t.participants
          .filter(p => p.team === participant.team && p !== participant)
          .map(p => ({ name: participantLabel(p), userId: p.racetimeUserId || null }))
          .filter(m => m.name)
      }
      : null;

    return {
      tournamentId: t._id,
      name: t.name,
      gameName: tournamentGameLabel(t, labelFor),
      gameSlug: t.gameSlug || t.gameId || t.game?.id || null,
      startDate: t.startDate || null,
      endDate: t.endDate || null,
      status,
      rank,
      rankComputed,
      entrants: entrantsCount(t),
      team,
      record: rank ? null : startggRecord(t, participant)
    };
  }).sort((a, b) => new Date(b.startDate || 0) - new Date(a.startDate || 0));
}

// Number of tournaments buildPlayerTournaments lists, without loading brackets
async function countPlayerTournaments({ Tournament, userId, names }) {
  const cleanNames = [...new Set(names.filter(Boolean))];
  const owner = { userId, normalizedNames: new Set(cleanNames.map(normalizeName)) };
  const tournaments = await Tournament.find(participantQuery({ userId, names: cleanNames }))
    .select('participants.racetimeUserId participants.racetimeName participants.name participants.displayName')
    .lean();
  return tournaments.filter(t => (t.participants || []).some(p => isPlayerParticipant(p, owner))).length;
}

module.exports = { buildPlayerTournaments, countPlayerTournaments, computeRankFromMatches };
