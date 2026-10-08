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
  syncParticipantAccounts
};
