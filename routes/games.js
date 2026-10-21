const express = require('express');
const { whenConnected } = require('../config/database');
const router = express.Router();
const { Game } = require('../models');
const { requireAdmin } = require('../middleware/admin-auth');

const GAMES_WITH_STATS_CACHE_TTL = 10 * 60 * 1000;
let gamesWithStatsCache = null;
let gamesWithStatsCacheExpiresAt = 0;
let gamesWithStatsInFlight = null;

const {
  buildCategoryResolutionContext,
  buildCategoryQuery,
  buildTournamentQuery,
  getExplicitRacetimeSlugs
} = require('../helpers/game-matching');
const racetimeLeaderboards = require('../services/racetime-leaderboards');

// Max simultaneous count queries: leaves database connections free for visitors
const STATS_QUERY_CONCURRENCY = 8;
const TOURNAMENT_FACET_BATCH = 100;

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Category list of a { category: 'x' } or { category: { $in: [...] } } query, or null
function categoriesOf(categoryQuery) {
  const keys = Object.keys(categoryQuery || {});
  if (keys.length !== 1 || keys[0] !== 'category') return null;
  const value = categoryQuery.category;
  if (typeof value === 'string') return [value];
  if (value && Object.keys(value).length === 1 && Array.isArray(value.$in) && value.$in.every(c => typeof c === 'string')) {
    return value.$in;
  }
  return null;
}

async function computeGamesWithStats() {
  const { Tournament, Race } = require('../models');
  const games = await Game.find().sort({ name: 1 });
  const resolutionContext = buildCategoryResolutionContext(games);

  // One grouped count over all races instead of one count query per game
  // (hundreds of simultaneous queries used to saturate the connection pool)
  const raceCountRows = await Race.aggregate([{ $group: { _id: '$category', count: { $sum: 1 } } }]);
  const raceCountByCategory = new Map(raceCountRows.map(row => [row._id, row.count]));

  // Tournament counts, many games per query: one $facet branch per game runs
  // that game's usual filter, so the counts are those of countDocuments
  const tournamentQueries = games.map(game => buildTournamentQuery(game, game.id.toLowerCase()));
  let tournamentCounts = null;
  try {
    const batches = [];
    for (let start = 0; start < games.length; start += TOURNAMENT_FACET_BATCH) {
      batches.push(start);
    }
    const batchCounts = await mapWithConcurrency(batches, 2, async (start) => {
      const facets = {};
      tournamentQueries.slice(start, start + TOURNAMENT_FACET_BATCH).forEach((query, i) => {
        facets[`g${i}`] = [{ $match: query }, { $count: 'n' }];
      });
      const [row] = await Tournament.aggregate([{ $facet: facets }]);
      return Object.keys(facets).map(key => (row && row[key] && row[key][0] ? row[key][0].n : 0));
    });
    tournamentCounts = batchCounts.flat();
  } catch (error) {
    console.warn('Grouped tournament counts failed, counting per game:', error?.message || error);
  }

  const gamesWithStats = await mapWithConcurrency(games, STATS_QUERY_CONCURRENCY, async (game, index) => {
    const gameIdLower = game.id.toLowerCase();
    const categoryQuery = buildCategoryQuery(game, gameIdLower, resolutionContext);

    const categories = categoriesOf(categoryQuery);
    const [totalRaces, totalTournaments] = await Promise.all([
      categories
        ? categories.reduce((sum, category) => sum + (raceCountByCategory.get(category) || 0), 0)
        : Race.countDocuments(categoryQuery),
      tournamentCounts ? tournamentCounts[index] : Tournament.countDocuments(tournamentQueries[index])
    ]);

    return {
      ...game.toObject(),
      totalRaces,
      totalTournaments
    };
  });

  return { games: gamesWithStats };
}

function refreshGamesWithStats() {
  if (!gamesWithStatsInFlight) {
    gamesWithStatsInFlight = computeGamesWithStats()
      .then((result) => {
        gamesWithStatsCache = result;
        gamesWithStatsCacheExpiresAt = Date.now() + GAMES_WITH_STATS_CACHE_TTL;
        return result;
      })
      .finally(() => {
        gamesWithStatsInFlight = null;
      });
  }
  return gamesWithStatsInFlight;
}

async function getGamesWithStatsCached() {
  if (gamesWithStatsCache) {
    // Computing the stats takes several seconds: once expired, keep serving
    // the previous result and refresh it in the background.
    if (gamesWithStatsCacheExpiresAt <= Date.now()) {
      refreshGamesWithStats().catch(err => {
        console.warn('Refresh /api/games/with-stats failed:', err?.message || err);
      });
    }
    return gamesWithStatsCache;
  }

  return refreshGamesWithStats();
}

// A game edit must show on the list right away, not after the TTL: recompute
// now, and again if a computation started before the edit is still running.
function invalidateGamesWithStats() {
  if (gamesWithStatsInFlight) {
    gamesWithStatsInFlight.finally(() => { gamesWithStatsCacheExpiresAt = 0; }).catch(() => {});
  }
  gamesWithStatsCacheExpiresAt = 0;
  refreshGamesWithStats().catch(err => {
    console.warn('Refresh /api/games/with-stats failed:', err?.message || err);
  });
}

// Warmed once MongoDB is connected
whenConnected(() => setTimeout(() => {
  getGamesWithStatsCached().catch(err => {
    console.warn('Warmup /api/games/with-stats failed:', err?.message || err);
  });
}, 1500));

// Get all games
router.get('/', async (req, res, next) => {
  try {
    const games = await Game.find().sort({ name: 1 });
    res.json({ games });
  } catch (error) {
    next(error);
  }
});

// Get all games with stats for sorting
router.get('/with-stats', async (req, res, next) => {
  try {
    const result = await getGamesWithStatsCached();
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Get game by ID
router.get('/:id', async (req, res, next) => {
  try {
    const game = await Game.findOne({ id: req.params.id });
    
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }

    res.json(game);
  } catch (error) {
    next(error);
  }
});

// Get game tournaments
router.get('/:id/tournaments', async (req, res, next) => {
  try {
    const { Tournament } = require('../models');
    const tournaments = await Tournament.find({ gameId: req.params.id })
      .sort({ startDate: -1 });

    res.json({ tournaments });
  } catch (error) {
    next(error);
  }
});

// Randomizer runs of speedrun marathons (GDQ), newest first
router.get('/:id/marathon-runs', async (req, res, next) => {
  try {
    const { MarathonRun, Player } = require('../models');
    const { exactNameRegex } = require('../helpers/player-races-filter');
    const runs = await MarathonRun.find({ gameSlug: req.params.id })
      .select('-_id source externalId event name category runners startedAt runTime videos')
      .sort({ startedAt: -1 })
      .lean();

    // A runner links to the player page whose name or alias it is, when only one player has it
    const names = [...new Set(runs.flatMap(run => run.runners || []))];
    const regexes = names.map(exactNameRegex);
    const players = regexes.length
      ? await Player.find({ $or: [{ name: { $in: regexes } }, { aliases: { $in: regexes } }], racetimeDeletedAt: null })
        .select('userId name aliases').lean()
      : [];
    const profiles = new Map();
    for (const name of names) {
      const re = exactNameRegex(name);
      const matches = players.filter(p => p.userId && (re.test(p.name) || (p.aliases || []).some(a => re.test(a))));
      if (matches.length === 1) profiles.set(name, matches[0].userId);
    }

    res.json({
      runs: runs.map(run => ({
        ...run,
        runners: (run.runners || []).map(name => ({ name, userId: profiles.get(name) || null }))
      }))
    });
  } catch (error) {
    next(error);
  }
});

// Get game statistics
router.get('/:id/stats', async (req, res, next) => {
  try {
    const { Tournament, Race } = require('../models');
    const gameId = req.params.id;
    const gameIdLower = gameId.toLowerCase();

    const gameDoc = await Game.findOne({ id: gameIdLower });
    const allGames = await Game.find().select('id integrations.racetime').lean();
    const resolutionContext = buildCategoryResolutionContext(allGames);
    const categoryQuery = buildCategoryQuery(gameDoc, gameIdLower, resolutionContext);
    const tournamentQuery = buildTournamentQuery(gameDoc, gameIdLower);
    
    const totalTournaments = await Tournament.countDocuments(tournamentQuery);
    const totalRaces = await Race.countDocuments(categoryQuery);
    
    // Get recent races
    const recentRaces = await Race.find(categoryQuery)
      .sort({ startedAt: -1 })
      .limit(10);
    
    // Get recent tournaments  
    const recentTournaments = await Tournament.find(tournamentQuery)
      .sort({ startDate: -1 })
      .limit(10);

    // Tournaments that can still be in progress or upcoming (a tournament is over one year
    // after its start): the page sorts them out with the same status rules as everywhere else
    const activeTournaments = await Tournament.find({
      ...tournamentQuery,
      startDate: { $gte: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000) },
      state: { $nin: ['complete', 'completed', 'awaiting_review'] }
    })
      .sort({ startDate: -1 })
      .limit(30)
      .select('name startDate endDate state status midosHouse.schedule');

    res.json({
      gameId,
      totalTournaments,
      totalRaces,
      recentRaces,
      recentTournaments,
      activeTournaments
    });
  } catch (error) {
    next(error);
  }
});

// "archipelago" / "multiworld" for a link to one of these sites, else null
function multiworldHost(url) {
  return (String(url || '').match(/^https?:\/\/(?:www\.)?(archipelago|multiworld)\.gg(?:\/|$)/i) || [])[1]?.toLowerCase() || null;
}

// "host/owner/repo" of a link to a code repository, else null
function repoKey(url) {
  const m = String(url || '').match(/^https?:\/\/(?:www\.)?(github\.com|gitlab\.com|codeberg\.org)\/([^/?#]+)\/([^/?#]+)/i);
  return m ? `${m[1]}/${m[2]}/${m[3].replace(/\.git$/, '')}`.toLowerCase() : null;
}

// Archipelago link hosted elsewhere than archipelago.gg / multiworld.gg (GitHub…)
function isCommunityApworld(site) {
  return !!(site?.isArchipelago || site?.isMultiworld) && !multiworldHost(site.url);
}

// Get game resources (sites, trackers, guides)
router.get('/:id/resources', async (req, res, next) => {
  try {
    const game = await Game.findOne({ id: req.params.id }).select('resources randomizer integrations').lean();
    
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }
    
    const resources = game.resources || {};
    
    // Déterminer le site officiel à afficher
    let officialSite = null;
    
    if (resources.officialSite?.url) {
      // Site officiel défini manuellement
      officialSite = resources.officialSite;
    } else if (resources.sites?.length === 1) {
      // Un seul site = c'est le site officiel
      officialSite = {
        url: resources.sites[0].url,
        name: resources.sites[0].name || 'Site officiel',
        isArchipelago: resources.sites[0].isArchipelago || false
      };
    } else if (game.randomizer?.website) {
      // Fallback sur le champ legacy
      officialSite = {
        url: game.randomizer.website,
        name: 'Site officiel',
        isArchipelago: game.randomizer.website?.includes('archipelago') || false
      };
    }
    
    // Filtrer les sites obsolètes pour l'affichage, ainsi que les liens génériques
    // vers archipelago.gg / multiworld.gg (rando-list) quand le jeu a sa page sur ce site.
    // Les APWorlds communautaires d'autres sources (rando-list, ajout à la main) s'effacent
    // aussi derrière ces pages (sans être supprimés) ; ceux du tableur (source "apworld")
    // sont déjà triés par sync-community-apworlds.js, qui garde les variantes, et passent
    // devant les autres liens vers le même dépôt (rando-list), sans statut ni mention APWorld
    const apworldRepos = new Set((resources.sites || [])
      .filter(s => s.source === 'apworld' && !s.isObsolete)
      .map(s => repoKey(s.url)).filter(Boolean));
    const syncedHosts = new Set((resources.sites || [])
      .filter(s => s.source === 'archipelago')
      .map(s => multiworldHost(s.url)));
    const activeSites = (resources.sites || []).filter(s =>
      !s.isObsolete &&
      !(s.source !== 'archipelago' && syncedHosts.has(multiworldHost(s.url))) &&
      !(syncedHosts.size && s.source !== 'apworld' && isCommunityApworld(s)) &&
      !(s.source !== 'apworld' && apworldRepos.has(repoKey(s.url))));

    res.json({
      officialSite,
      hasMultiworldPage: syncedHosts.size > 0,
      sites: activeSites,
      trackers: resources.trackers || [],
      guides: resources.guides || [],
      other: resources.other || [],
      hasSingleSite: activeSites.length === 1,
      hasMultipleSites: activeSites.length > 1
    });
  } catch (error) {
    next(error);
  }
});

// Racetime leaderboards of the game: its goals with ranked players, and the
// ranking of one (?slug=&goal=, by default the current goal with the most players)
router.get('/:id/leaderboards', async (req, res, next) => {
  try {
    const { Player } = require('../models');
    const game = await Game.findOne({ id: req.params.id }).select('id integrations.racetime').lean();
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }

    const { categories, unavailable } = await racetimeLeaderboards.getGameCategories(game);
    const boards = categories.flatMap(category => category.leaderboards
      .filter(board => board.numRanked > 0)
      .map(board => ({ category, board })));
    boards.sort((a, b) => (b.board.active - a.board.active) || (b.board.numRanked - a.board.numRanked));

    const selected = boards.find(({ category, board }) => category.slug === req.query.slug && board.goal === req.query.goal)
      || boards[0];
    let ranking = null;
    if (selected) {
      const { category, board } = selected;
      const userIds = board.rankings.map(r => r.userId).filter(Boolean);
      const players = await Player.find({ userId: { $in: userIds } }).select('userId').lean();
      const known = new Set(players.map(p => p.userId));
      ranking = {
        slug: category.slug,
        goal: board.goal,
        active: board.active,
        numRanked: board.numRanked,
        url: `https://racetime.gg/${encodeURIComponent(category.slug)}/leaderboards`,
        rankings: board.rankings.map(r => ({ ...r, hasProfile: known.has(r.userId) }))
      };
    }

    const fetchedAt = categories.map(c => c.fetchedAt).sort((a, b) => a - b)[0] || null;
    res.json({
      goals: boards.map(({ category, board }) => ({
        slug: category.slug,
        categoryName: category.name,
        goal: board.goal,
        active: board.active,
        numRanked: board.numRanked
      })),
      ranking,
      fetchedAt,
      unavailable
    });
  } catch (error) {
    next(error);
  }
});

const GOAL_STATS_CACHE_TTL = 10 * 60 * 1000;
const RECENT_RACES_DAYS = 30;
// Goals of a category racetime does not answer for: those with enough races to not be one-off custom goals
const MIN_RACES_WITHOUT_RACETIME = 5;
const goalStatsCache = new Map();

// Races of a game per (racetime slug, goal): { races, recentRaces, lastRaceAt }
async function getGoalRaceStats(gameId, slugs) {
  const cached = goalStatsCache.get(gameId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const { Race } = require('../models');
  const since = new Date(Date.now() - RECENT_RACES_DAYS * 24 * 3600 * 1000);
  const rows = await Race.aggregate([
    { $match: { category: { $in: slugs } } },
    {
      $group: {
        _id: { slug: '$category', goal: '$goal' },
        races: { $sum: 1 },
        recentRaces: { $sum: { $cond: [{ $gte: ['$startedAt', since] }, 1, 0] } },
        lastRaceAt: { $max: '$startedAt' }
      }
    }
  ]);
  const value = new Map(rows.map(row => [`${row._id.slug}\n${row._id.goal}`, {
    races: row.races,
    recentRaces: row.recentRaces,
    lastRaceAt: row.lastRaceAt
  }]));
  goalStatsCache.set(gameId, { value, expiresAt: Date.now() + GOAL_STATS_CACHE_TTL });
  return value;
}

// Categories of the game: the ones written for it, the main settings, and every
// racetime goal (current and archived) with its races and ranked players
router.get('/:id/categories', async (req, res, next) => {
  try {
    const game = await Game.findOne({ id: req.params.id })
      .select('id integrations.racetime categories categorySettings').lean();
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }

    const slugs = getExplicitRacetimeSlugs(game);
    const [{ categories: racetimeCategories, unavailable }, raceStats] = await Promise.all([
      racetimeLeaderboards.getGameCategories(game),
      getGoalRaceStats(game.id, slugs)
    ]);

    const noRaces = { races: 0, recentRaces: 0, lastRaceAt: null };
    const goals = new Map();
    for (const category of racetimeCategories) {
      const numRanked = new Map(category.leaderboards.map(board => [board.goal, board.numRanked]));
      const names = new Set([...category.activeGoals, ...numRanked.keys()]);
      for (const goal of names) {
        const key = `${category.slug}\n${goal}`;
        goals.set(key, {
          slug: category.slug,
          goal,
          active: category.activeGoals.includes(goal),
          numRanked: numRanked.get(goal) || 0,
          ...(raceStats.get(key) || noRaces)
        });
      }
    }

    // Races whose goal is not a racetime goal: custom goals typed when opening the room
    const knownSlugs = new Set(racetimeCategories.map(c => c.slug));
    let customGoalRaces = 0;
    for (const [key, stats] of raceStats) {
      if (goals.has(key)) continue;
      const [slug, goal] = key.split('\n');
      if (knownSlugs.has(slug) || !goal || goal === 'null' || stats.races < MIN_RACES_WITHOUT_RACETIME) {
        customGoalRaces += stats.races;
        continue;
      }
      goals.set(key, { slug, goal, active: null, numRanked: 0, ...stats });
    }

    const categories = (game.categories || []).map(category => {
      // Racetime goals, or custom goals a category is played with (e.g. one per league season)
      const categoryGoals = (category.racetimeGoals || [])
        .map(({ slug, goal }) => {
          const key = `${slug}\n${goal}`;
          if (goals.has(key)) return goals.get(key);
          return raceStats.has(key) ? { slug, goal, active: null, numRanked: 0, ...raceStats.get(key) } : null;
        })
        .filter(Boolean);
      const lastRaceAt = categoryGoals.map(g => g.lastRaceAt).filter(Boolean).sort((a, b) => b - a)[0] || null;
      return {
        id: category.id,
        name: category.name,
        description: category.description,
        translations: category.translations || {},
        goals: categoryGoals,
        races: categoryGoals.reduce((sum, g) => sum + g.races, 0),
        recentRaces: categoryGoals.reduce((sum, g) => sum + g.recentRaces, 0),
        lastRaceAt
      };
    });

    res.json({
      categories,
      settings: game.categorySettings || [],
      goals: [...goals.values()].sort((a, b) => (Number(b.active) - Number(a.active)) || (b.races - a.races)),
      customGoalRaces,
      recentRacesDays: RECENT_RACES_DAYS,
      unavailable
    });
  } catch (error) {
    next(error);
  }
});

// Update game resources (admin)
router.patch('/:id/resources', requireAdmin, async (req, res, next) => {
  try {
    const { officialSite, trackers, guides, other } = req.body;
    
    const updateData = {};
    
    if (officialSite !== undefined) {
      updateData['resources.officialSite'] = officialSite;
    }
    if (trackers !== undefined) {
      updateData['resources.trackers'] = trackers;
    }
    if (guides !== undefined) {
      updateData['resources.guides'] = guides;
    }
    if (other !== undefined) {
      updateData['resources.other'] = other;
    }
    
    const game = await Game.findOneAndUpdate(
      { id: req.params.id },
      { $set: updateData },
      { new: true }
    );
    
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }
    
    res.json({ success: true, resources: game.resources });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
module.exports.invalidateGamesWithStats = invalidateGamesWithStats;
