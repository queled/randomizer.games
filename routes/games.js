const express = require('express');
const router = express.Router();
const { Game } = require('../models');
const { requireAdmin } = require('../middleware/admin-auth');

const GAMES_WITH_STATS_CACHE_TTL = 10 * 60 * 1000;
let gamesWithStatsCache = null;
let gamesWithStatsCacheExpiresAt = 0;
let gamesWithStatsInFlight = null;

const CATEGORY_ALIASES = {
  'oot': ['oot', 'ootr'],
  'alttp': ['alttp', 'alttpr', 'alttpr-ladder'],
  'mm': ['mm', 'mmr'],
  'sm': ['sm', 'smr'],
  'sm64': ['sm64'],
  'tww': ['tww'],
  'dk64': ['dk64', 'dk64r'],
  'tp': ['tp'],
  'kh2fm': ['kh2fm', 'kh2r', 'kh2fmr'],
  'sotn': ['sotn'],
  'smz3': ['smz3'],
  'ootmm': ['ootmm'],
  'z1': ['z1', 'z1r'],
  'z2': ['z2', 'z2r']
};

const GAME_NAME_PATTERNS = {
  'oot': /ocarina\s*(of)?\s*time/i,
  'alttp': /link\s*(to)?\s*(the)?\s*past/i,
  'mm': /majora'?s?\s*mask/i,
  'sm': /super\s*metroid/i,
  'sm64': /super\s*mario\s*64/i,
  'dk64': /donkey\s*kong\s*64/i,
  'tww': /wind\s*waker/i,
  'tp': /twilight\s*princess/i,
  'kh2fm': /kingdom\s*hearts\s*(2|ii)/i,
  'sotn': /symphony\s*(of)?\s*(the)?\s*night/i,
  'smz3': /(^|\W)smz3($|\W)/i,
  'ootmm': /(^|\W)ootmm(r)?($|\W)/i,
  'z1': /(^|\W)(the\s+legend\s+of\s+zelda|zelda\s*1|z1r?)($|\W)/i,
  'z2': /(^|\W)(zelda\s*ii|adventure\s+of\s+link|z2r?)($|\W)/i
};

function escapeRegex(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getExplicitRacetimeSlugs(gameDoc) {
  const slugs = new Set();

  const primary = gameDoc?.integrations?.racetime?.gameSlug;
  const extras = Array.isArray(gameDoc?.integrations?.racetime?.gameSlugs)
    ? gameDoc.integrations.racetime.gameSlugs
    : [];

  if (primary) slugs.add(String(primary).toLowerCase().trim());
  extras.forEach(slug => {
    if (slug) slugs.add(String(slug).toLowerCase().trim());
  });

  return Array.from(slugs).filter(Boolean);
}

function buildCategoryResolutionContext(games) {
  const explicitSlugOwners = new Map();
  const allGameIds = new Set();

  for (const game of games || []) {
    const gameId = String(game?.id || '').toLowerCase().trim();
    if (!gameId) continue;

    allGameIds.add(gameId);
    const explicitSlugs = getExplicitRacetimeSlugs(game);

    for (const slug of explicitSlugs) {
      if (!explicitSlugOwners.has(slug)) {
        explicitSlugOwners.set(slug, new Set());
      }
      explicitSlugOwners.get(slug).add(gameId);
    }
  }

  return { explicitSlugOwners, allGameIds };
}

function buildCategoryQuery(gameDoc, gameIdLower, resolutionContext = { explicitSlugOwners: new Map(), allGameIds: new Set() }) {
  const explicitSlugs = getExplicitRacetimeSlugs(gameDoc);
  const explicitSet = new Set(explicitSlugs);

  const categories = new Set();
  categories.add(gameIdLower);
  categories.add(`${gameIdLower}r`);

  const aliases = CATEGORY_ALIASES[gameIdLower] || [];
  aliases.forEach(c => categories.add(String(c).toLowerCase()));
  explicitSlugs.forEach(c => categories.add(String(c).toLowerCase()));

  for (const category of Array.from(categories)) {
    if (!category) {
      categories.delete(category);
      continue;
    }

    const owners = resolutionContext.explicitSlugOwners.get(category);
    if (owners && !owners.has(gameIdLower) && !explicitSet.has(category)) {
      categories.delete(category);
      continue;
    }

    const isOtherGameId = resolutionContext.allGameIds.has(category) && category !== gameIdLower;
    if (isOtherGameId && !explicitSet.has(category)) {
      categories.delete(category);
    }
  }

  const all = Array.from(categories).filter(Boolean);
  if (all.length === 0) {
    return { category: '__no_matching_category__' };
  }
  if (all.length === 1) {
    return { category: all[0] };
  }
  return { category: { $in: all } };
}

function buildTournamentQuery(gameDoc, gameIdLower) {
  const gamePattern = GAME_NAME_PATTERNS[gameIdLower];
  const conditions = [];

  if (gameDoc?._id) {
    conditions.push({ game: gameDoc._id });
  }

  if (gamePattern) {
    conditions.push({ gameName: { $regex: gamePattern } });
  }

  const candidateNames = [
    gameDoc?.name,
    gameDoc?.official?.name,
    gameDoc?.randomizer?.displayName,
    gameDoc?.randomizer?.shortName
  ].filter(Boolean);

  candidateNames.forEach(name => {
    conditions.push({ gameName: { $regex: new RegExp(escapeRegex(name), 'i') } });
  });

  if (conditions.length === 0) {
    return {};
  }

  return { $or: conditions };
}

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

async function getGamesWithStatsCached() {
  if (gamesWithStatsCache && gamesWithStatsCacheExpiresAt > Date.now()) {
    return gamesWithStatsCache;
  }

  if (gamesWithStatsInFlight) {
    return gamesWithStatsInFlight;
  }

  gamesWithStatsInFlight = (async () => {
    const result = await computeGamesWithStats();
    gamesWithStatsCache = result;
    gamesWithStatsCacheExpiresAt = Date.now() + GAMES_WITH_STATS_CACHE_TTL;
    return result;
  })();

  try {
    return await gamesWithStatsInFlight;
  } finally {
    gamesWithStatsInFlight = null;
  }
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
