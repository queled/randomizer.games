/**
 * Racetime account of each tournament participant, learned from the races linked to
 * its matches. Organizers type any name in the bracket ("Ultimastrike"); racetime
 * says who actually raced ("Ultimaderp"). Kept per tournament, unlike player aliases,
 * so a bracket name never captures someone else's racetime account elsewhere.
 */
const { normalizeName, scoreNameMatch } = require('./race-match-linking');
const { escapeRegex, getExplicitRacetimeSlugs } = require('./game-matching');

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

// How well a racetime name must fit a bracket name to be its leftover account
const MIN_LOOKALIKE_SCORE = 120;

// How much better a member's name must fit its account than the next one
const MIN_MEMBER_MARGIN = 40;

/**
 * Racetime account of each team member, from the races linked to the team's matches
 * ("Team A vs Team B"): the accounts that raced against most of the team's opponents
 * are its members, each paired with the member name it fits best. When one member is
 * left for one account, they go together, whatever their names.
 * `teams`: Map(normalized team name → member names)
 * → Map(normalized team name → Map(normalized member name → { userId, userName }))
 */
function learnTeamAccounts(races, teams) {
  const result = new Map();
  const sorted = [...(races || [])].sort((a, b) => new Date(a.startedAt || 0) - new Date(b.startedAt || 0));

  for (const [team, memberNames] of teams) {
    // Opponent → accounts that raced the team against it
    const byOpponent = new Map();
    const labels = new Map();
    for (const race of sorted) {
      const sides = String(race?.matchPlayers || '').split(/\s+vs\s+/i).map(normalizeName);
      if (sides.length !== 2 || sides[0] === sides[1] || !sides.includes(team)) continue;
      const opponent = sides[0] === team ? sides[1] : sides[0];
      if (!byOpponent.has(opponent)) byOpponent.set(opponent, new Set());
      for (const entrant of race.entrants || []) {
        if (!entrant?.userId) continue;
        byOpponent.get(opponent).add(entrant.userId);
        labels.set(entrant.userId, entrant.userName);
      }
    }
    // An opponent's players race the team once: members race it against several opponents
    if (byOpponent.size < 2) continue;
    const counts = new Map();
    for (const accounts of byOpponent.values()) {
      for (const userId of accounts) counts.set(userId, (counts.get(userId) || 0) + 1);
    }
    const accounts = [...counts].filter(([, count]) => count >= 2 && count * 2 > byOpponent.size).map(([userId]) => userId);
    if (!accounts.length || accounts.length > memberNames.length) continue;

    const members = memberNames.map(normalizeName).filter(Boolean);
    const pairs = [];
    for (const member of members) {
      for (const userId of accounts) {
        const score = scoreNameMatch(normalizeName(labels.get(userId)), member);
        if (score > 0) pairs.push({ member, userId, score });
      }
    }
    // Best fits first, each member and account once, and clearly better than the others
    pairs.sort((a, b) => b.score - a.score);
    const accountOf = new Map();
    const taken = new Set();
    for (const pair of pairs) {
      if (accountOf.has(pair.member) || taken.has(pair.userId)) continue;
      const rival = pairs.find((other) => other !== pair && !taken.has(other.userId) && !accountOf.has(other.member)
        && (other.member === pair.member || other.userId === pair.userId));
      if (rival && pair.score - rival.score < MIN_MEMBER_MARGIN) continue;
      accountOf.set(pair.member, pair.userId);
      taken.add(pair.userId);
    }
    const leftMembers = members.filter((member) => !accountOf.has(member));
    const leftAccounts = accounts.filter((userId) => !taken.has(userId));
    if (leftMembers.length === 1 && leftAccounts.length === 1 && accounts.length === members.length) {
      accountOf.set(leftMembers[0], leftAccounts[0]);
    }

    if (!accountOf.size) continue;
    result.set(team, new Map([...accountOf].map(([member, userId]) => [member, { userId, userName: labels.get(userId) }])));
  }
  return result;
}

/**
 * Names a participant goes by in the bracket: start.gg shows a solo entrant as
 * "Prefix | GamerTag" in its sets, the participant is stored by its gamer tag.
 */
function participantKeys(participant) {
  const keys = [participant.displayName, participant.name];
  if (participant.prefix) keys.push(`${participant.prefix} ${participant.name}`);
  return [...new Set(keys.map(normalizeName).filter(Boolean))];
}

/**
 * Racetime accounts already known for bracket names and start.gg users, over every
 * tournament: a participant whose matches were never raced on a linked room (or
 * imported later) gets the account the same person raced with elsewhere. A name kept
 * by several accounts is left out: it may be two people.
 * → { byName: Map(normalized name → account), byStartggUser: Map(id → account) }
 */
async function loadKnownAccounts(Tournament) {
  const rows = await Tournament.aggregate([
    { $unwind: '$participants' },
    { $match: { 'participants.racetimeUserId': { $nin: [null, ''] } } },
    {
      $project: {
        _id: 0,
        name: '$participants.name',
        displayName: '$participants.displayName',
        prefix: '$participants.prefix',
        startggUserId: '$participants.startggUserId',
        userId: '$participants.racetimeUserId',
        userName: '$participants.racetimeName'
      }
    }
  ]);

  const collect = (map, key, row) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, new Map());
    map.get(key).set(row.userId, { userId: row.userId, userName: row.userName });
  };
  const names = new Map();
  const startggUsers = new Map();
  for (const row of rows) {
    for (const key of participantKeys(row)) collect(names, key, row);
    collect(startggUsers, row.startggUserId ? String(row.startggUserId) : null, row);
  }
  const single = (map) => new Map([...map].filter(([, accounts]) => accounts.size === 1)
    .map(([key, accounts]) => [key, [...accounts.values()][0]]));
  return { byName: single(names), byStartggUser: single(startggUsers) };
}

/**
 * Racetime accounts that raced under these exact names (case aside) in the game of the
 * tournament: racetime says who a name is, but only among the players of that game, so a
 * Melee bracket name never becomes a namesake who races something else.
 * → Map(normalized name → Map(userId → { userId, userName, races }))
 */
async function findRaceNameAccounts(Race, names, categories) {
  const result = new Map();
  if (!names.length || !categories.length) return result;
  const regexes = names.map((name) => new RegExp(`^${escapeRegex(name)}$`, 'i'));
  const rows = await Race.aggregate([
    { $match: { category: { $in: categories }, 'entrants.userName': { $in: regexes } } },
    { $unwind: '$entrants' },
    { $match: { 'entrants.userName': { $in: regexes }, 'entrants.userId': { $nin: [null, ''] } } },
    { $group: { _id: '$entrants.userId', userName: { $last: '$entrants.userName' }, races: { $sum: 1 } } }
  ]);
  for (const row of rows) {
    const key = normalizeName(row.userName);
    if (!result.has(key)) result.set(key, new Map());
    result.get(key).set(row._id, { userId: row._id, userName: row.userName, races: row.races });
  }
  return result;
}

// Racetime categories of the tournament: those of its races and of its game
async function tournamentCategories(tournament, races, Race) {
  const categories = new Set(races.map((race) => race.category).filter(Boolean));
  let game = tournament.game && typeof tournament.game === 'object' && tournament.game.integrations ? tournament.game : null;
  if (!game && tournament.game) {
    game = await Race.db.model('Game').findById(tournament.game._id || tournament.game).select('integrations.racetime').lean();
  }
  getExplicitRacetimeSlugs(game).forEach((slug) => categories.add(slug));
  return [...categories];
}

// Bracket name learned from the sets of a start.gg participant stored without its prefix:
// the only learned name ending with its gamer tag ("prefix | tag")
function findPrefixedName(accounts, key) {
  const found = [...accounts.keys()].filter((name) => name.endsWith(` ${key}`));
  return found.length === 1 ? accounts.get(found[0]) : null;
}

/**
 * Set `racetimeUserId` / `racetimeName` on the participants of a tournament (a mongoose
 * document), from its races linked to matches, then from the accounts the same names
 * raced with in other tournaments. Returns the participants changed.
 */
async function syncParticipantAccounts({ tournament, Race, knownAccounts = null, dryRun = false }) {
  if (!Array.isArray(tournament?.participants) || !tournament.participants.length) return [];

  const races = await Race.find({
    tournamentId: tournament._id,
    matchPlayers: { $nin: [null, ''] },
    $or: [{ matchId: { $ne: null } }, { startggSetId: { $nin: [null, ''] } }]
  }).select('category matchPlayers startedAt entrants.userId entrants.userName').lean();
  const accounts = learnBracketAccounts(races);

  const teams = new Map();
  for (const participant of tournament.participants) {
    const team = normalizeName(participant.team);
    if (!team) continue;
    if (!teams.has(team)) teams.set(team, []);
    teams.get(team).push(participant.displayName || participant.name);
  }
  const teamAccounts = teams.size ? learnTeamAccounts(races, teams) : new Map();

  const known = knownAccounts || (typeof tournament.constructor?.aggregate === 'function'
    ? await loadKnownAccounts(tournament.constructor)
    : { byName: new Map(), byStartggUser: new Map() });
  const isStartgg = tournament.source?.type === 'startgg';

  // Participants no race taught anything about: the racetime account of their exact name
  const learned = (participant) => participant.racetimeUserId
    || participantKeys(participant).some((key) => accounts.has(key) || known.byName.has(key))
    || (participant.team && teamAccounts.get(normalizeName(participant.team))?.size);
  const unknownNames = [...new Set(tournament.participants.filter((p) => !learned(p))
    .flatMap((p) => [p.displayName, p.name]).filter(Boolean))];
  const raceNames = unknownNames.length
    ? await findRaceNameAccounts(Race, unknownNames, await tournamentCategories(tournament, races, Race))
    : new Map();
  const tournamentUserIds = new Set(races.flatMap((race) => (race.entrants || []).map((e) => e.userId)).filter(Boolean));
  const accountOfRaceName = (key) => {
    const candidates = [...(raceNames.get(key) || new Map()).values()];
    if (candidates.length === 1) return candidates[0];
    // A name several accounts raced under: the one that raced this tournament
    const inTournament = candidates.filter((candidate) => tournamentUserIds.has(candidate.userId));
    return inTournament.length === 1 ? inTournament[0] : null;
  };

  const changed = [];
  for (const participant of tournament.participants) {
    const keys = participantKeys(participant);
    let account;
    if (participant.team) {
      // A team's races hold all its members: each member is found among them
      const members = teamAccounts.get(normalizeName(participant.team));
      account = members && keys.map((key) => members.get(key)).find(Boolean);
    } else {
      account = keys.map((key) => accounts.get(key)).find(Boolean)
        || (isStartgg && !participant.prefix && findPrefixedName(accounts, normalizeName(participant.name)));
    }
    account = account
      || (participant.racetimeUserId ? null : (participant.startggUserId && known.byStartggUser.get(String(participant.startggUserId)))
        || keys.map((key) => known.byName.get(key)).find(Boolean)
        || keys.map(accountOfRaceName).find(Boolean));
    if (!account) continue;
    if (participant.racetimeUserId === account.userId && participant.racetimeName === account.userName) continue;
    changed.push({ name: participant.displayName || participant.name, from: participant.racetimeName || null, to: account.userName });
    participant.racetimeUserId = account.userId;
    participant.racetimeName = account.userName;
  }

  // Still unknown: the account of the tournament's races no participant has, that looks
  // like the name ("blueroses" racing as "blueroses4u"), when it fits no other one
  const linkedIds = new Set(tournament.participants.map((p) => p.racetimeUserId).filter(Boolean));
  const freeAccounts = new Map();
  for (const entrant of races.flatMap((race) => race.entrants || [])) {
    if (entrant.userId && !linkedIds.has(entrant.userId)) freeAccounts.set(entrant.userId, entrant.userName);
  }
  const unlinked = tournament.participants.filter((p) => !p.racetimeUserId);
  const fits = (participant, userName) => participantKeys(participant).some((key) =>
    Math.max(scoreNameMatch(normalizeName(userName), key), scoreNameMatch(key, normalizeName(userName))) >= MIN_LOOKALIKE_SCORE);
  for (const participant of unlinked) {
    const candidates = [...freeAccounts].filter(([, userName]) => fits(participant, userName));
    if (candidates.length !== 1) continue;
    const [userId, userName] = candidates[0];
    if (unlinked.some((other) => other !== participant && fits(other, userName))) continue;
    changed.push({ name: participant.displayName || participant.name, from: null, to: userName });
    participant.racetimeUserId = userId;
    participant.racetimeName = userName;
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
  learnTeamAccounts,
  loadKnownAccounts,
  syncParticipantAccounts
};
