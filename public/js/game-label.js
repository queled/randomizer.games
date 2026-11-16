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

// Multiworld races (racetime.gg/archipelago) are tied to the games they were played
// with: their labels joined, else the category's. labelOf: slug or game id → label.
// Mirrored by helpers/multiworld-races.js.
window.raceGameLabel = function raceGameLabel(race, labelOf) {
  if (!race?.multiworld) return labelOf(race?.category);
  const names = (race.games || []).map(id => labelOf(id)).filter(Boolean);
  return names.length ? names.join(' + ') : (race.category === 'archipelago' ? 'Archipelago' : race.category);
};

// Badge of a multiworld race: played in teams, out of the stats
window.multiworldBadge = function multiworldBadge(race) {
  if (!race?.multiworld) return '';
  const title = (typeof i18n !== 'undefined' && i18n.t('races.multiworldHint') !== 'races.multiworldHint')
    ? i18n.t('races.multiworldHint')
    : 'Multiworld race (Archipelago), played in teams: not counted in the stats';
  const safe = String(title).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<span class="badge-multiworld" title="${safe}">Multiworld</span>`;
};
