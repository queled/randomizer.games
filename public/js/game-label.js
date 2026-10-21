// The name a game goes by across the site: its randomizer's name, the game's own
// only as a fallback. Mirrored by helpers/game-label.js: keep both in sync.
window.gameLabel = function gameLabel(game) {
  return game?.randomizer?.displayName
    || game?.randomizer?.shortName
    || game?.official?.name
    || game?.name
    || game?.id
    || null;
};
