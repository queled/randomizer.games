// The name a game goes by across the site: its randomizer's name, the game's own
// only as a fallback. Mirrored by public/js/game-label.js: keep both in sync.
function gameLabel(game) {
  return game?.randomizer?.displayName
    || game?.randomizer?.shortName
    || game?.official?.name
    || game?.name
    || game?.id
    || null;
}

// Labels keyed by game id, racetime category and the other names a game goes by,
// so a race or tournament shows its game's label rather than a racetime slug or
// the game name imported with a bracket
async function loadGameLabels() {
  const { Game } = require('../models');
  const docs = await Game.find({})
    .select('id name official.name randomizer.name randomizer.displayName randomizer.shortName integrations.racetime.gameSlug integrations.racetime.gameSlugs')
    .lean();
  const labels = new Map();
  // Weakest key first: other names, "<id>r", then the id, then the racetime slugs
  docs.forEach(g => {
    [g.name, g.randomizer && g.randomizer.name, g.randomizer && g.randomizer.displayName, g.randomizer && g.randomizer.shortName, g.official && g.official.name]
      .filter(Boolean)
      .forEach(name => labels.set(name.toLowerCase(), gameLabel(g)));
  });
  docs.forEach(g => { if (g.id) labels.set(`${g.id}r`.toLowerCase(), gameLabel(g)); });
  // Older tournaments store the game's Mongo _id as gameId
  docs.forEach(g => labels.set(String(g._id), gameLabel(g)));
  docs.forEach(g => { if (g.id) labels.set(g.id.toLowerCase(), gameLabel(g)); });
  docs.forEach(g => {
    const rt = (g.integrations && g.integrations.racetime) || {};
    [rt.gameSlug, ...(rt.gameSlugs || [])].filter(Boolean)
      .forEach(slug => labels.set(slug.toLowerCase(), gameLabel(g)));
  });
  return (key) => {
    if (!key) return null;
    const k = String(key).toLowerCase().trim();
    // "<official name> Randomizer" → that game's label
    return labels.get(k) || labels.get(k.replace(/\s+randomizer$/, '')) || null;
  };
}

// A tournament's label: its linked game first, the name imported with the bracket last
function tournamentGameLabel(tournament, labelFor) {
  const game = tournament?.game;
  // A populated game; an unpopulated ref is an ObjectId, which labelFor resolves
  if (game && (game.randomizer || game.official || game.name)) return gameLabel(game);
  return (labelFor && (labelFor(game) || labelFor(tournament?.gameId) || labelFor(tournament?.gameSlug) || labelFor(tournament?.gameName)))
    || tournament?.gameName
    || null;
}

module.exports = { gameLabel, loadGameLabels, tournamentGameLabel };
