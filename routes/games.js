const express = require('express');
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
  buildTournamentQuery
} = require('../helpers/game-matching');

async function computeGamesWithStats() {
  const { Tournament, Race } = require('../models');
  const games = await Game.find().sort({ name: 1 });
  const resolutionContext = buildCategoryResolutionContext(games);

  const gamesWithStats = await Promise.all(games.map(async (game) => {
    const gameIdLower = game.id.toLowerCase();
    const categoryQuery = buildCategoryQuery(game, gameIdLower, resolutionContext);
    const tournamentQuery = buildTournamentQuery(game, gameIdLower);

    const [totalRaces, totalTournaments] = await Promise.all([
      Race.countDocuments(categoryQuery),
      Tournament.countDocuments(tournamentQuery)
    ]);

    return {
      ...game.toObject(),
      totalRaces,
      totalTournaments
    };
  }));

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

setTimeout(() => {
  getGamesWithStatsCached().catch(err => {
    console.warn('Warmup /api/games/with-stats failed:', err?.message || err);
  });
}, 1500);

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

    res.json({
      gameId,
      totalTournaments,
      totalRaces,
      recentRaces,
      recentTournaments
    });
  } catch (error) {
    next(error);
  }
});

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
    
    // Filtrer les sites obsolètes pour l'affichage
    const activeSites = (resources.sites || []).filter(s => !s.isObsolete);
    
    res.json({
      officialSite,
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
