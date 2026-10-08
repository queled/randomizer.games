/**
 * Goal filters of racetime.gg categories shared with non-randomizer races
 * (e.g. "ffmq", where "Any%" races are vanilla speedruns).
 */

const { Game } = require('../models');

// slug -> RegExp of a game's integrations.racetime (Mongoose Map or lean object)
function gameGoalFilters(racetime) {
  const raw = racetime?.goalFilters;
  const entries = raw instanceof Map ? [...raw] : Object.entries(raw || {});
  return new Map(entries.filter(([, pattern]) => pattern).map(([slug, pattern]) => [slug, new RegExp(pattern, 'i')]));
}

// slug -> RegExp, for every game
async function loadGoalFilters() {
  const games = await Game.find({ 'integrations.racetime.goalFilters': { $exists: true } })
    .select('integrations.racetime.goalFilters').lean();

  const filters = new Map();
  for (const game of games) {
    for (const [slug, regex] of gameGoalFilters(game.integrations.racetime)) filters.set(slug, regex);
  }
  return filters;
}

function isGoalAllowed(filters, slug, goal) {
  const regex = filters.get(slug);
  if (!regex) return true;
  return regex.test(goal?.name || goal || '');
}

module.exports = { gameGoalFilters, loadGoalFilters, isGoalAllowed };
