const express = require('express');
const router = express.Router();
const { Game } = require('../models');

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
    const { Tournament, Race } = require('../models');
    const games = await Game.find().sort({ name: 1 });
    
    // Get stats for all games in parallel
    const gamesWithStats = await Promise.all(games.map(async (game) => {
      const gameIdLower = game.id.toLowerCase();
      
      // Build category query using racetime slug(s) from integrations
      // The race.category field contains the racetime slug (e.g., 'ootr', 'alttpr', 'alttpr-ladder')
      const racetimeSlug = game.integrations?.racetime?.gameSlug;
      const racetimeSlugs = game.integrations?.racetime?.gameSlugs || [];
      
      // Combo games that combine multiple racetime categories
      const comboCategories = {
        'ootmm': ['ootmmr', 'ootr', 'mmr'],
        'smz3': ['smz3', 'alttpr', 'smr'],
        'hodbt': ['hodr', 'bmtr'],
        'mpcg': ['mpcgr', 'mpr', 'mp2r'],
        'z1m1': ['z1m1', 'z1r', 'm1r'],
        'z1m1z3m3': ['z1m1z3m3', 'z1r', 'm1r', 'alttpr', 'mp3r']
      };
      
      let categoryQuery;
      if (comboCategories[gameIdLower]) {
        // For combo games, search in all related categories
        categoryQuery = { category: { $in: comboCategories[gameIdLower] } };
      } else if (racetimeSlug && racetimeSlugs.length > 0) {
        // Include both primary slug and additional slugs (like alttpr-ladder)
        categoryQuery = { category: { $in: [racetimeSlug, ...racetimeSlugs] } };
      } else if (racetimeSlug) {
        // Use only the primary racetime slug
        categoryQuery = { category: racetimeSlug };
      } else {
        // Fallback to game id
        categoryQuery = { category: gameIdLower };
      }
      
      // Build tournament query - search by game ref or gameName pattern
      const gamePatterns = {
        'oot': /ocarina\s*(of)?\s*time/i,
        'alttp': /link\s*(to)?\s*(the)?\s*past/i,
        'albw': /link\s*(between)?\s*worlds/i,
        'mm': /majora'?s?\s*mask/i,
        'sm': /super\s*metroid/i,
        'sm64': /super\s*mario\s*64/i,
        'dk64': /donkey\s*kong\s*64/i,
        'tww': /wind\s*waker/i,
        'tp': /twilight\s*princess/i,
        'kh2fm': /kingdom\s*hearts\s*(2|ii)/i,
        'sotn': /symphony\s*(of)?\s*(the)?\s*night/i,
        'smz3': /smz3|super\s*metroid.*link/i,
        'ootmm': /ootmm|ocarina.*majora/i,
        'hk': /hollow\s*knight/i,
        'botw': /breath\s*(of)?\s*(the)?\s*wild/i,
        'ss': /skyward\s*sword/i
      };
      
      const gamePattern = gamePatterns[gameIdLower];
      let tournamentQuery = {};
      const conditions = [{ game: game._id }];
      if (gamePattern) {
        conditions.push({ gameName: { $regex: gamePattern } });
      }
      // Also match by game name directly
      if (game.name) {
        conditions.push({ gameName: { $regex: new RegExp(game.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') } });
      }
      tournamentQuery = { $or: conditions };
      
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
    
    res.json({ games: gamesWithStats });
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

// Game ID aliases (maps game IDs to their racetime category slugs)
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
  'ootmm': ['ootmm']
};

// Combo games should also search for their source games
const COMBO_GAME_CATEGORIES = {
  'ootmm': ['ootmm', 'oot', 'ootr', 'mm', 'mmr'],
  'smz3': ['smz3', 'alttp', 'alttpr', 'sm', 'smr']
};

// Game name patterns for tournament search
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
  'smz3': /smz3|super\s*metroid.*link/i,
  'ootmm': /ootmm|ocarina.*majora/i
};

// Combo game tournament name patterns
const COMBO_GAME_PATTERNS = {
  'ootmm': [/ocarina\s*(of)?\s*time/i, /majora'?s?\s*mask/i],
  'smz3': [/link\s*(to)?\s*(the)?\s*past/i, /super\s*metroid/i]
};

// Get game statistics
router.get('/:id/stats', async (req, res, next) => {
  try {
    const { Tournament, Race, Game } = require('../models');
    const gameId = req.params.id;
    const gameIdLower = gameId.toLowerCase();
    
    // Build category query with aliases and integrations slugs for races
    // For combo games, search all source game categories
    const comboCategories = COMBO_GAME_CATEGORIES[gameIdLower];
    let categoryQuery;
    
    if (comboCategories) {
      categoryQuery = { category: { $in: comboCategories } };
    } else {
      // Get game doc to access integrations.racetime.gameSlugs
      const gameDoc = await Game.findOne({ id: gameId });
      const racetimeSlug = gameDoc?.integrations?.racetime?.gameSlug;
      const racetimeSlugs = gameDoc?.integrations?.racetime?.gameSlugs || [];
      
      if (racetimeSlug && racetimeSlugs.length > 0) {
        // Include both primary slug and additional slugs (like alttpr-ladder)
        categoryQuery = { category: { $in: [racetimeSlug, ...racetimeSlugs] } };
      } else {
        const aliases = CATEGORY_ALIASES[gameIdLower];
        categoryQuery = aliases && aliases.length > 1 
          ? { category: { $in: aliases } }
          : { category: gameId };
      }
    }
    
    // Build tournament query - search by gameName pattern or by game ObjectId
    const gameDoc = await Game.findOne({ id: gameId });
    const comboPatterns = COMBO_GAME_PATTERNS[gameIdLower];
    const gamePattern = GAME_NAME_PATTERNS[gameIdLower];
    
    let tournamentQuery = {};
    if (gameDoc) {
      // Search by game reference OR by gameName pattern(s)
      const conditions = [{ game: gameDoc._id }];
      
      if (comboPatterns) {
        // For combo games, match any of the source game patterns
        comboPatterns.forEach(pattern => {
          conditions.push({ gameName: { $regex: pattern } });
        });
      } else if (gamePattern) {
        conditions.push({ gameName: { $regex: gamePattern } });
      }
      
      tournamentQuery = { $or: conditions };
    } else if (comboPatterns) {
      // For combo games without game doc, match any source pattern
      tournamentQuery = { $or: comboPatterns.map(p => ({ gameName: { $regex: p } })) };
    } else if (gamePattern) {
      tournamentQuery = { gameName: { $regex: gamePattern } };
    }
    
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
router.patch('/:id/resources', async (req, res, next) => {
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
