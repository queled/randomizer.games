// Tournaments two players both entered (compare page): each one's final rank and
// the bracket matches they played against each other.
const { calculateTournamentStatus } = require('./tournament-status');

function normalizeName(name) {
  if (!name) return '';
  return name.toString().toLowerCase().trim().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// "https://racetime.gg/<category>/<room>" or "/<category>/<room>" → "/<category>/<room>"
function racetimeRoomPath(url) {
  return String(url || '').replace(/^https?:\/\/(?:www\.)?racetime\.gg/i, '').replace(/\/+$/, '').toLowerCase() || null;
}

const escapeRegex = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Tournaments where a participant may be this player: racetime account or bracket name
function participantQuery(player) {
  const nameRegex = new RegExp(Array.from(player.names).map(n => `^${escapeRegex(n)}$`).join('|'), 'i');
  const or = [
    { 'participants.racetimeName': nameRegex },
    { 'participants.name': nameRegex },
    { 'participants.displayName': nameRegex }
  ];
  if (player.userId) or.unshift({ 'participants.racetimeUserId': player.userId });
  return { $or: or };
}

// Who a participant is, with the same rule as the players list: the racetime account
// that raced the participant's matches, else its bracket name
function participantOwner(part, players) {
  const byAccount = players.find(p => p.userId && part.racetimeUserId === p.userId);
  if (byAccount) return byAccount.key;
  const rawName = normalizeName(part.racetimeName || part.displayName || part.name);
  if (!rawName) return null;
  const owner = players.find(p => p.normalizedNames.has(rawName));
  return owner ? owner.key : null;
}

// "PlayerA 2 - PlayerB 1" → scores in the order of the match's player1/player2
function startggScores(match) {
  const ds = String(match.displayScore || '').trim();
  const sides = ds.split(' - ');
  if (sides.length !== 2) return null;
  const parsed = sides.map(side => {
    const m = side.trim().match(/^(.*)\s+(\d+)$/);
    return m ? { name: normalizeName(m[1]), score: Number(m[2]) } : null;
  });
  if (!parsed[0] || !parsed[1]) return null;
  const firstIsPlayer2 = parsed[0].name === normalizeName(match.player2?.name)
    && parsed[0].name !== normalizeName(match.player1?.name);
  return firstIsPlayer2 ? [parsed[1].score, parsed[0].score] : [parsed[0].score, parsed[1].score];
}

// Above this, a Challonge "score" is not a count of races won (some group stages
// store a points or time total there)
const MAX_MATCH_SCORE = 99;

// "2-1" (one score per set, comma separated) → [2, 1] summed over the sets
function challongeScores(scoresCsv) {
  const sets = String(scoresCsv || '').split(',').map(s => s.trim().match(/^(\d+)-(\d+)$/));
  if (!sets.length || sets.some(m => !m)) return null;
  const scores = sets.reduce((acc, m) => [acc[0] + Number(m[1]), acc[1] + Number(m[2])], [0, 0]);
  return Math.max(...scores) > MAX_MATCH_SCORE ? null : scores;
}

function bestRank(entries) {
  const ranks = entries.map(e => Number(e.finalRank)).filter(r => Number.isFinite(r) && r > 0);
  return ranks.length ? Math.min(...ranks) : null;
}

/**
 * @param players two { key: 'player1'|'player2', names: Set of names/aliases, userId, rankByTournament: Map }
 * @param raceIdByRoom racetime room path → id of a common race, to link a match to its race
 */
async function buildCommonTournaments({ Tournament, Match, players, raceIdByRoom }) {
  for (const p of players) p.normalizedNames = new Set(Array.from(p.names).map(normalizeName));
  const [p1, p2] = players;

  const tournaments = await Tournament.find({ $and: [participantQuery(p1), participantQuery(p2)] })
    .select('name gameName startDate endDate state participants participantsCount matches.startggSetId matches.round matches.phase matches.phaseGroup matches.displayScore matches.completedAt matches.winnerId matches.player1 matches.player2 matches.raceUrl matches.raceUrls midosHouse.schedule.startAt')
    .populate('game', 'name randomizer.shortName')
    .lean();

  const entries = [];
  for (const t of tournaments) {
    const parts = { player1: [], player2: [] };
    for (const part of t.participants || []) {
      const owner = participantOwner(part, players);
      if (owner) parts[owner].push(part);
    }
    if (!parts.player1.length || !parts.player2.length) continue;

    const team1 = parts.player1.find(p => p.team)?.team;
    const teammates = !!team1 && parts.player2.some(p => p.team === team1);

    entries.push({ t, parts, teammates });
  }

  // Bracket matches of Challonge tournaments live in their own collection
  const challongeMatches = new Map();
  const challongeIds = entries.filter(e => !(e.t.matches || []).length).map(e => e.t._id);
  if (challongeIds.length) {
    const matches = await Match.find({ tournamentId: { $in: challongeIds } })
      .select('tournamentId player1Id player2Id player1Name player2Name winnerId scoresCsv round groupId phase completedAt state raceUrl')
      .lean();
    for (const m of matches) {
      const key = String(m.tournamentId);
      if (!challongeMatches.has(key)) challongeMatches.set(key, []);
      challongeMatches.get(key).push(m);
    }
  }

  const raceIdOf = urls => {
    for (const url of urls) {
      const id = raceIdByRoom.get(racetimeRoomPath(url));
      if (id) return id;
    }
    return null;
  };

  const result = entries.map(({ t, parts, teammates }) => {
    const sideOf = (ids, names) => {
      for (const key of ['player1', 'player2']) {
        const own = parts[key];
        if (ids.some(id => id != null && own.some(p => String(p.startggEntrantId) === String(id) || String(p.challongeId) === String(id)))) return key;
        const ownNames = new Set(own.flatMap(p => [p.name, p.displayName]).filter(Boolean).map(normalizeName));
        if (names.some(n => ownNames.has(normalizeName(n)))) return key;
      }
      return null;
    };

    const matches = [];
    if (!teammates) {
      for (const m of t.matches || []) {
        const a = sideOf([m.player1?.startggEntrantId], [m.player1?.name, ...(m.player1?.members || [])]);
        const b = sideOf([m.player2?.startggEntrantId], [m.player2?.name, ...(m.player2?.members || [])]);
        if (!a || !b || a === b) continue;
        const scores = startggScores(m);
        const winnerSide = m.winnerId == null ? null
          : String(m.winnerId) === String(m.player1?.startggEntrantId) ? a
            : String(m.winnerId) === String(m.player2?.startggEntrantId) ? b : null;
        matches.push({
          phase: [m.phase, m.phaseGroup].filter(Boolean).join(' '),
          round: m.round ?? null,
          groupStage: false,
          completedAt: m.completedAt || null,
          winner: winnerSide,
          score: scores ? { player1: a === 'player1' ? scores[0] : scores[1], player2: a === 'player1' ? scores[1] : scores[0] } : null,
          raceId: raceIdOf([...(m.raceUrls || []), m.raceUrl].filter(Boolean))
        });
      }
      for (const m of challongeMatches.get(String(t._id)) || []) {
        const a = sideOf([m.player1Id], [m.player1Name]);
        const b = sideOf([m.player2Id], [m.player2Name]);
        if (!a || !b || a === b) continue;
        const scores = challongeScores(m.scoresCsv);
        const winnerSide = m.winnerId == null ? null
          : m.winnerId === m.player1Id ? a
            : m.winnerId === m.player2Id ? b : null;
        matches.push({
          phase: m.phase || '',
          round: m.round ?? null,
          groupStage: m.groupId != null,
          completedAt: m.completedAt || null,
          winner: winnerSide,
          score: scores ? { player1: a === 'player1' ? scores[0] : scores[1], player2: a === 'player1' ? scores[1] : scores[0] } : null,
          raceId: raceIdOf([m.raceUrl].filter(Boolean))
        });
      }
      matches.sort((x, y) => new Date(x.completedAt || 0) - new Date(y.completedAt || 0));
    }

    const rankOf = key => bestRank(parts[key])
      ?? players.find(p => p.key === key).rankByTournament.get(String(t._id))
      ?? null;

    return {
      tournamentId: t._id,
      name: t.name,
      gameName: t.gameName || t.game?.randomizer?.shortName || t.game?.name || null,
      startDate: t.startDate || null,
      status: calculateTournamentStatus(t),
      participantsCount: t.participantsCount || (t.participants || []).length || null,
      teammates,
      player1: { rank: rankOf('player1') },
      player2: { rank: rankOf('player2') },
      matches
    };
  }).sort((a, b) => new Date(b.startDate || 0) - new Date(a.startDate || 0));

  const summary = { betterRank: { player1: 0, player2: 0 }, matchWins: { player1: 0, player2: 0 } };
  for (const t of result) {
    const r1 = t.player1.rank;
    const r2 = t.player2.rank;
    if (!t.teammates && t.status === 'terminé' && r1 && r2 && r1 !== r2) {
      summary.betterRank[r1 < r2 ? 'player1' : 'player2']++;
    }
    for (const m of t.matches) if (m.winner) summary.matchWins[m.winner]++;
  }

  return { tournaments: result, summary };
}

module.exports = { buildCommonTournaments, racetimeRoomPath };
