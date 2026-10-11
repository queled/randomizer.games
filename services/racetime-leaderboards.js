/**
 * Racetime.gg leaderboards and goals of a game, kept in memory.
 *
 * Racetime ranks players per goal with a score, for its current goals and the
 * archived ones. A category is fetched when a page asks for it and kept an
 * hour; when racetime does not answer, the previous copy is served.
 */

const racetime = require('./racetime');
const { getExplicitRacetimeSlugs } = require('../helpers/game-matching');
const { gameGoalFilters } = require('../helpers/racetime-goals');

const CACHE_TTL_MS = 60 * 60 * 1000;
// Wait before asking racetime again after a failure, while serving the old copy
const RETRY_AFTER_MS = 5 * 60 * 1000;

// slug -> { value, expiresAt, pending }
const cache = new Map();

async function fetchCategory(slug) {
  const [info, data] = await Promise.all([
    racetime.getCategoryInfo(slug),
    racetime.getLeaderboard(slug)
  ]);
  if (!info) return null;

  const activeGoals = new Set(info.goals);
  return {
    slug,
    name: info.name,
    fetchedAt: new Date(),
    activeGoals: info.goals,
    leaderboards: (data?.leaderboards || []).map(board => ({
      goal: board.goal,
      active: activeGoals.has(board.goal),
      numRanked: board.num_ranked ?? (board.rankings || []).length,
      rankings: (board.rankings || []).map(r => ({
        // Deleted racetime accounts come back without a user
        userId: r.user?.id || null,
        name: r.user?.name || null,
        place: r.place,
        score: r.score,
        bestTimeMs: racetime.durationToMs(r.best_time),
        timesRaced: r.times_raced
      }))
    }))
  };
}

/**
 * Goals and leaderboards of a racetime category, or null when it does not exist.
 */
function getCategory(slug) {
  const entry = cache.get(slug) || {};
  if (entry.expiresAt > Date.now()) return Promise.resolve(entry.value);

  if (!entry.pending) {
    entry.pending = fetchCategory(slug)
      .then(value => {
        cache.set(slug, { value, expiresAt: Date.now() + CACHE_TTL_MS });
        return value;
      })
      .catch(error => {
        delete entry.pending;
        if (entry.value === undefined) throw error;
        console.warn(`Racetime leaderboards of ${slug}: ${error.message}, serving the copy of ${entry.value?.fetchedAt?.toISOString()}`);
        entry.expiresAt = Date.now() + RETRY_AFTER_MS;
        return entry.value;
      });
    cache.set(slug, entry);
  }
  return entry.pending;
}

/**
 * Racetime categories of a game (its configured slugs), with only the goals its
 * goal filters keep. A category racetime does not answer for is left out and
 * named in `unavailable`.
 */
async function getGameCategories(game) {
  const slugs = getExplicitRacetimeSlugs(game);
  const filters = gameGoalFilters(game?.integrations?.racetime);
  const results = await Promise.allSettled(slugs.map(getCategory));

  const categories = [];
  const unavailable = [];
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      console.warn(`Racetime leaderboards of ${slugs[i]}: ${result.reason?.message || result.reason}`);
      unavailable.push(slugs[i]);
      return;
    }
    const category = result.value;
    if (!category) return;
    const filter = filters.get(category.slug);
    if (!filter) {
      categories.push(category);
      return;
    }
    categories.push({
      ...category,
      activeGoals: category.activeGoals.filter(goal => filter.test(goal)),
      leaderboards: category.leaderboards.filter(board => filter.test(board.goal))
    });
  });

  return { categories, unavailable };
}

module.exports = { getCategory, getGameCategories };
