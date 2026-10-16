const { Game } = require('../models');

async function findGameForTournament({ providedGameSlug, providedGameId, tournamentName, tournamentDescription }) {
  // 1) explicit slug param
  if (providedGameSlug) {
    const g = await Game.findOne({ id: providedGameSlug });
    if (g) return { gameId: g._id, gameSlug: g.id };
  }

  // 2) legacy/objectId
  if (providedGameId && /^[a-f0-9]{24}$/.test(String(providedGameId))) {
    const g = await Game.findById(providedGameId);
    if (g) return { gameId: g._id, gameSlug: g.id };
  }

  // 3) try find by slug equal to providedGameId
  if (providedGameId) {
    const g = await Game.findOne({ id: providedGameId });
    if (g) return { gameId: g._id, gameSlug: g.id };
  }

  // 4) heuristic on name/description
  const text = ((tournamentName || '') + ' ' + (tournamentDescription || '')).toLowerCase();
  const games = await Game.find({}).lean();
  // Whole-word match: short slugs/names like "tp" or "Nier" must not hit inside "alttpr" or "Turnier"
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hasWord = (needle, suffix = '') => !!needle && new RegExp(`(^|[^a-z0-9])${escape(needle.trim())}${suffix}([^a-z0-9]|$)`).test(text);
  const pick = (test) => {
    const g = games.find(test);
    return g ? { gameId: g._id, gameSlug: g.id } : null;
  };
  // Full name first, so "The Legend of Zelda: A Link to the Past" is not taken by any "The Legend of Zelda: ..." prefix
  return pick(g => g.name && hasWord(g.name.toLowerCase()))
    // Slugs also match their rando abbreviation: "ootr" → oot, "alttpr" → alttp
    || pick(g => hasWord(g.id.toLowerCase(), 'r?'))
    || pick(g => g.name && hasWord(g.name.toLowerCase().split(':')[0]));
}

module.exports = findGameForTournament;
