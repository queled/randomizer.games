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
  for (const g of games) {
    if (text.includes(g.id.toLowerCase())) return { gameId: g._id, gameSlug: g.id };
    if (g.name && text.includes(g.name.toLowerCase().split(':')[0])) return { gameId: g._id, gameSlug: g.id };
  }

  return null;
}

module.exports = findGameForTournament;
