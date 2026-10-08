/**
 * Goal filters of racetime.gg categories shared with non-randomizer races
 * (e.g. "ffmq", where "Any%" races are vanilla speedruns).
 */

const { Game } = require('../models');

// slug -> RegExp, for the categories whose game sets integrations.racetime.goalFilter
async function loadGoalFilters() {
  const games = await Game.find({ 'integrations.racetime.goalFilter': { $nin: [null, ''] } })
    .select('integrations.racetime').lean();

  const filters = new Map();
  for (const game of games) {
    const { gameSlug, gameSlugs = [], goalFilter } = game.integrations.racetime;
    const regex = new RegExp(goalFilter, 'i');
    for (const slug of [gameSlug, ...gameSlugs]) {
      if (slug) filters.set(slug, regex);
    }
  }
  return filters;
}

function isGoalAllowed(filters, slug, goal) {
  const regex = filters.get(slug);
  if (!regex) return true;
  return regex.test(goal?.name || goal || '');
}

module.exports = { loadGoalFilters, isGoalAllowed };
