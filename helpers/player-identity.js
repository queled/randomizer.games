/**
 * Who a race entrant or a tournament participant is, the same way on every page.
 *
 * A player is a racetime account (userId): two accounts with the same name are two
 * players. A race entrant without account (SpeedRunsLive history, manual import) or a
 * bracket participant not linked to one belongs to the player that has its name as an
 * alias, else to the only player with that name. A name shared by several players
 * attaches to none of them: it stays a player known by name only.
 */
const { normalizePlayerName } = require('./player-aliases');
const { exactNameRegex } = require('./player-races-filter');

const accountKey = userId => `u:${userId}`;
const nameKey = normalized => `n:${normalized}`;

function addTo(map, key, value) {
  if (!key) return;
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
}

const onlyOne = set => (set && set.size === 1 ? set.values().next().value : null);

/**
 * Identity index of Player documents (`userId`, `name` and `aliases` are needed).
 */
function buildPlayerIdentity(playerDocs) {
  const userIdsByName = new Map();
  const userIdsByAlias = new Map();

  for (const player of playerDocs || []) {
    if (!player?.userId) continue;
    const ownName = normalizePlayerName(player.name);
    addTo(userIdsByName, ownName, player.userId);
    for (const alias of player.aliases || []) {
      const key = normalizePlayerName(alias);
      if (key && key !== ownName) addTo(userIdsByAlias, key, player.userId);
    }
  }

  // An alias first (aliases are set by hand), else a current name
  const nameOwner = normalized => (userIdsByAlias.has(normalized)
    ? onlyOne(userIdsByAlias.get(normalized))
    : onlyOne(userIdsByName.get(normalized)));

  /** Key of a race entrant: `u:<userId>` or `n:<normalized name>` (null without either). */
  function keyOfEntrant({ userId, userName } = {}) {
    if (userId) return accountKey(userId);
    const normalized = normalizePlayerName(userName);
    if (!normalized) return null;
    const owner = nameOwner(normalized);
    return owner ? accountKey(owner) : nameKey(normalized);
  }

  /** Key of a tournament participant, by racetime account then by its names. */
  function keyOfParticipant({ racetimeUserId, racetimeName, displayName, name } = {}) {
    if (racetimeUserId) return accountKey(racetimeUserId);
    const names = [racetimeName, displayName, name].map(normalizePlayerName).filter(Boolean);
    for (const normalized of names) {
      const owner = nameOwner(normalized);
      if (owner) return accountKey(owner);
    }
    return names.length ? nameKey(names[0]) : null;
  }

  /**
   * The names (current name, aliases) that point to this player only: the race entrants
   * without account and the bracket participants of these names are theirs.
   */
  function namesOf(player) {
    const names = [player?.name, ...(player?.aliases || [])]
      .filter(name => name && nameOwner(normalizePlayerName(name)) === player?.userId);
    return [...new Set(names)];
  }

  return { keyOfEntrant, keyOfParticipant, namesOf };
}

/**
 * The names of a player that point to them only (see namesOf), read from the players
 * sharing one of their names or aliases. A player without account keeps all of them.
 */
async function loadOwnNames(Player, player) {
  const all = [player?.name, ...(player?.aliases || [])].filter(Boolean);
  if (!player?.userId) return [...new Set(all)];
  const regexes = all.map(exactNameRegex);
  const others = regexes.length
    ? await Player.find({ userId: { $ne: player.userId }, $or: [{ name: { $in: regexes } }, { aliases: { $in: regexes } }] })
      .select('userId name aliases').lean()
    : [];
  return buildPlayerIdentity([player, ...others]).namesOf(player);
}

/**
 * The player a name page shows: the account of that current name, else of that alias.
 * Several accounts of that name: the one written exactly so, else the one with the most
 * races. Null when none.
 */
async function findPlayerByName({ Player, Race, name, select, populate }) {
  const regex = exactNameRegex(name);
  const find = filter => {
    let query = Player.find(filter);
    if (select) query = query.select(select);
    if (populate) query = query.populate(populate);
    return query.lean();
  };
  let candidates = await find({ name: regex });
  if (!candidates.length) candidates = await find({ aliases: regex });
  if (candidates.length <= 1) return candidates[0] || null;

  const exact = candidates.filter(p => p.name === name);
  if (exact.length === 1) return exact[0];
  const pool = exact.length ? exact : candidates;
  const counts = await Promise.all(pool.map(p => (p.userId
    ? Race.countDocuments({ 'entrants.userId': p.userId })
    : Promise.resolve(0))));
  let best = 0;
  counts.forEach((c, i) => { if (c > counts[best]) best = i; });
  return pool[best];
}

// Names raced under without account (SpeedRunsLive history, manual imports), normalized:
// a player's name is looked for in the races only when some race has it so, since a
// case-insensitive name lookup reads the whole name index (~200 ms) where an account
// lookup takes a few ms. A superset (every entrant of those races) is enough.
const ACCOUNTLESS_NAMES_TTL = 60 * 60 * 1000;
const accountlessNames = { expires: 0, promise: null };

function loadAccountlessNames(Race) {
  if (accountlessNames.promise && accountlessNames.expires > Date.now()) return accountlessNames.promise;
  accountlessNames.expires = Date.now() + ACCOUNTLESS_NAMES_TTL;
  accountlessNames.promise = Race.distinct('entrants.userName', { entrants: { $elemMatch: { userId: { $in: [null, ''] } } } })
    .then(names => new Set(names.map(normalizePlayerName).filter(Boolean)))
    .catch(error => {
      accountlessNames.expires = 0;
      throw error;
    });
  return accountlessNames.promise;
}

/** The names among `names` that some race entrant without account has. */
async function namesRacedWithoutAccount(Race, names) {
  if (!names.length) return [];
  const known = await loadAccountlessNames(Race);
  return names.filter(name => known.has(normalizePlayerName(name)));
}

module.exports = { accountKey, nameKey, buildPlayerIdentity, loadOwnNames, findPlayerByName, namesRacedWithoutAccount };
