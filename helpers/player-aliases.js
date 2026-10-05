/**
 * Player aliases resolution, backed by the `aliases` field of the Player collection.
 *
 * An alias is an alternate name (e.g. a Challonge participant name) that refers to
 * the same person as a Player document. The Player `name` is the canonical name.
 */

/**
 * Normalize name for matching (case-insensitive, trim, remove accents)
 */
function normalizePlayerName(name) {
  if (!name && name !== 0) return '';
  return String(name)
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * Build a lookup index from Player documents (only `name` and `aliases` are needed).
 */
function buildAliasIndex(players) {
  const canonicalByAlias = new Map();
  const aliasesByCanonical = new Map();

  for (const player of players || []) {
    const canonical = player?.name;
    const canonicalKey = normalizePlayerName(canonical);
    if (!canonicalKey || !Array.isArray(player.aliases)) continue;

    for (const alias of player.aliases) {
      const aliasKey = normalizePlayerName(alias);
      if (!aliasKey || aliasKey === canonicalKey) continue;
      canonicalByAlias.set(aliasKey, canonical);
      if (!aliasesByCanonical.has(canonicalKey)) aliasesByCanonical.set(canonicalKey, []);
      aliasesByCanonical.get(canonicalKey).push(alias);
    }
  }

  return { canonicalByAlias, aliasesByCanonical };
}

/**
 * Load the alias index from the database (only players that declare aliases).
 */
async function loadAliasIndex(Player) {
  const players = await Player.find({ 'aliases.0': { $exists: true } })
    .select('name aliases')
    .lean();
  return buildAliasIndex(players);
}

/**
 * Get the canonical name for a player name, or the name itself when it has no alias.
 */
function getCanonicalName(index, name) {
  if (!name) return name;
  return index?.canonicalByAlias.get(normalizePlayerName(name)) || name;
}

/**
 * Get all known aliases for a canonical name.
 */
function getAliases(index, canonicalName) {
  return index?.aliasesByCanonical.get(normalizePlayerName(canonicalName)) || [];
}

module.exports = {
  normalizePlayerName,
  buildAliasIndex,
  loadAliasIndex,
  getCanonicalName,
  getAliases
};
