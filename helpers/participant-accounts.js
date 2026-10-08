/**
 * Racetime account of each tournament participant, learned from the races linked to
 * its matches. Organizers type any name in the bracket ("Ultimastrike"); racetime
 * says who actually raced ("Ultimaderp"). Kept per tournament, unlike player aliases,
 * so a bracket name never captures someone else's racetime account elsewhere.
 */
const { normalizeName, scoreNameMatch } = require('./race-match-linking');

// How much better one pairing of the two entrants must fit the two bracket names
const MIN_PAIRING_MARGIN = 140;

function addVote(votes, key, value, label) {
  if (!votes.has(key)) votes.set(key, new Map());
  const entry = votes.get(key).get(value) || { count: 0, label };
  entry.count++;
  entry.label = label;
  votes.get(key).set(value, entry);
}

// The most voted value, when no other one ties it
function topVote(candidates) {
  const sorted = [...(candidates || new Map())].sort((a, b) => b[1].count - a[1].count);
  if (!sorted.length || (sorted[1] && sorted[1][1].count === sorted[0][1].count)) return null;
  return { value: sorted[0][0], ...sorted[0][1] };
}

/**
 * Racetime account of each bracket name, from 1v1 races linked to a match
 * (`matchPlayers` "A vs B"): the pairing of the two entrants that fits the two names.
 * When one entrant is clearly one player, the other one is the other player,
 * whatever their names. → Map(normalized bracket name → { userId, userName })
 */
function learnBracketAccounts(races) {
  const accountsByName = new Map();
  // Races sorted oldest first: the latest racetime name wins
  const sorted = [...(races || [])].sort((a, b) => new Date(a.startedAt || 0) - new Date(b.startedAt || 0));

  for (const race of sorted) {
    const players = String(race?.matchPlayers || '').split(/\s+vs\s+/i).map(normalizeName);
    const entrants = race?.entrants || [];
    if (players.length !== 2 || players.some((p) => !p) || players[0] === players[1]) continue;
    if (entrants.length !== 2 || entrants.some((e) => !e?.userId)) continue;

    const names = entrants.map((e) => normalizeName(e.userName));
    const straight = scoreNameMatch(names[0], players[0]) + scoreNameMatch(names[1], players[1]);
    const crossed = scoreNameMatch(names[0], players[1]) + scoreNameMatch(names[1], players[0]);
    if (Math.abs(straight - crossed) < MIN_PAIRING_MARGIN) continue;

    const order = straight > crossed ? [0, 1] : [1, 0];
    order.forEach((playerIndex, entrantIndex) => {
      const entrant = entrants[entrantIndex];
      addVote(accountsByName, players[playerIndex], entrant.userId, entrant.userName);
    });
  }

  // One account per bracket name, and one bracket name per account
  const best = new Map();
  for (const [name, candidates] of accountsByName) {
    const top = topVote(candidates);
    if (top) best.set(name, top);
  }
  const namesByAccount = new Map();
  for (const [name, top] of best) {
    if (!namesByAccount.has(top.value)) namesByAccount.set(top.value, new Map());
    namesByAccount.get(top.value).set(name, { count: top.count });
  }

  const result = new Map();
  for (const [name, top] of best) {
    if (topVote(namesByAccount.get(top.value))?.value !== name) continue;
    result.set(name, { userId: top.value, userName: top.label });
  }
  return result;
}

// How far a 1v1 room may be from the reported result of a match to be one of its games
const SCHEDULE_WINDOW_MS = 24 * 60 * 60 * 1000;
// Matches of a bracket name the same racetime account must have raced
const MIN_SCHEDULE_MATCHES = 2;

function getMatchTime(match) {
  const time = new Date(match?.completedAt || match?.startedAt || 0).getTime();
  return Number.isNaN(time) ? 0 : time;
}

/**
 * Racetime account of bracket names it looks nothing like ("Natorade" racing as
 * "Nathann"), from the tournament schedule: on the day of most of its matches, the
 * same account raced a 1v1 room against that match's opponent. Learned before any race
 * is linked, so the rooms of these matches can be linked.
 * → Map(normalized racetime name → Set(normalized bracket name))
 */
function learnScheduleAccounts(matches, races) {
  const bracketNames = new Set(matches.flatMap((match) => [
    normalizeName(match.player1Name),
    normalizeName(match.player2Name)
  ]).filter(Boolean));
  const rooms = (races || [])
    .filter((race) => (race?.entrants || []).length === 2)
    .map((race) => ({
      time: new Date(race.endedAt || race.startedAt || 0).getTime(),
      names: race.entrants.map((entrant) => normalizeName(entrant?.userName || entrant?.name))
    }))
    .filter((room) => room.time && room.names.every(Boolean) && room.names[0] !== room.names[1]);
  const matchesNobody = (name) => [...bracketNames].every((bracketName) => scoreNameMatch(name, bracketName) === 0);

  const votes = new Map();
  const datedMatches = new Map();
  for (const match of matches) {
    // A team's rooms hold all its members
    if (match.player1Members?.length || match.player2Members?.length) continue;
    const players = [normalizeName(match.player1Name), normalizeName(match.player2Name)];
    const time = getMatchTime(match);
    if (!time || players.some((player) => !player) || players[0] === players[1]) continue;

    for (const [opponent, player] of [players, [...players].reverse()]) {
      datedMatches.set(player, (datedMatches.get(player) || 0) + 1);
      const accounts = new Set();
      for (const room of rooms) {
        if (Math.abs(room.time - time) > SCHEDULE_WINDOW_MS) continue;
        for (const [known, other] of [room.names, [...room.names].reverse()]) {
          if (scoreNameMatch(known, opponent) >= 200 && scoreNameMatch(known, player) === 0 && matchesNobody(other)) {
            accounts.add(other);
          }
        }
      }
      // One vote per match, however many games it took
      for (const account of accounts) addVote(votes, player, account, account);
    }
  }

  // The account raced most of the bracket name's matches, and no other name's
  const best = new Map();
  for (const [player, candidates] of votes) {
    const top = topVote(candidates);
    if (!top || top.count < MIN_SCHEDULE_MATCHES || top.count * 2 < datedMatches.get(player)) continue;
    best.set(player, top.value);
  }
  const result = new Map();
  for (const [player, account] of best) {
    if ([...best.values()].filter((value) => value === account).length > 1) continue;
    result.set(account, new Set([player]));
  }
  return result;
}

/**
 * Set `racetimeUserId` / `racetimeName` on the participants of a tournament (a mongoose
 * document), from its races linked to matches. Returns the participants changed.
 */
async function syncParticipantAccounts({ tournament, Race, dryRun = false }) {
  if (!Array.isArray(tournament?.participants) || !tournament.participants.length) return [];

  const races = await Race.find({
    tournamentId: tournament._id,
    matchPlayers: { $nin: [null, ''] },
    $or: [{ matchId: { $ne: null } }, { startggSetId: { $nin: [null, ''] } }]
  }).select('matchPlayers startedAt entrants.userId entrants.userName').lean();
  const accounts = learnBracketAccounts(races);

  const changed = [];
  for (const participant of tournament.participants) {
    // A team's races hold all its members: the team has no single account
    if (participant.team) continue;
    const account = accounts.get(normalizeName(participant.displayName || participant.name))
      || accounts.get(normalizeName(participant.name));
    if (!account) continue;
    if (participant.racetimeUserId === account.userId && participant.racetimeName === account.userName) continue;
    changed.push({ name: participant.displayName || participant.name, from: participant.racetimeName || null, to: account.userName });
    participant.racetimeUserId = account.userId;
    participant.racetimeName = account.userName;
  }

  if (changed.length && !dryRun) {
    tournament.markModified('participants');
    await tournament.save();
  }
  return changed;
}

module.exports = {
  learnBracketAccounts,
  learnScheduleAccounts,
  syncParticipantAccounts
};
