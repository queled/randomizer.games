/**
 * Admin Routes
 * 
 * API endpoints for admin panel functionality.
 * All routes require admin authentication.
 */

const express = require('express');
const router = express.Router();
const { 
  verifyAdminToken, 
  createSession, 
  destroySession, 
  requireAdmin 
} = require('../middleware/admin-auth');
const { Game, Tournament, Race, Player } = require('../models');

// ==================== AUTH ====================

/**
 * POST /api/admin/login
 * Login with admin token
 */
router.post('/login', (req, res) => {
  const { token } = req.body;
  
  if (!token) {
    return res.status(400).json({ error: 'Token required' });
  }
  
  if (!verifyAdminToken(token)) {
    // Add delay to prevent brute force
    setTimeout(() => {
      res.status(401).json({ error: 'Invalid admin token' });
    }, 1000);
    return;
  }
  
  const sessionToken = createSession('admin');
  
  // Set cookie for browser
  res.cookie('adminSession', sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  });
  
  res.json({ 
    success: true, 
    token: sessionToken,
    expiresIn: 24 * 60 * 60 // seconds
  });
});

/**
 * POST /api/admin/logout
 * Logout and destroy session
 */
router.post('/logout', requireAdmin, (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    destroySession(authHeader.slice(7));
  }
  
  res.clearCookie('adminSession');
  res.json({ success: true });
});

/**
 * GET /api/admin/session
 * Check if current session is valid
 */
router.get('/session', requireAdmin, (req, res) => {
  res.json({ 
    valid: true, 
    session: {
      adminId: req.adminSession.adminId,
      expiresAt: new Date(req.adminSession.expiresAt).toISOString()
    }
  });
});

// ==================== GAMES CRUD ====================

/**
 * GET /api/admin/games
 * List all games with full details
 */
router.get('/games', requireAdmin, async (req, res, next) => {
  try {
    const { search, enabled, limit = 50, page = 1 } = req.query;
    
    const query = {};
    
    if (search) {
      query.$or = [
        { id: { $regex: search, $options: 'i' } },
        { name: { $regex: search, $options: 'i' } },
        { 'randomizer.shortName': { $regex: search, $options: 'i' } }
      ];
    }
    
    if (enabled !== undefined) {
      query.enabled = enabled === 'true';
    }
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const [games, total] = await Promise.all([
      Game.find(query)
        .sort({ name: 1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Game.countDocuments(query)
    ]);
    
    res.json({
      games,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/games/:id
 * Get single game with full details
 */
router.get('/games/:id', requireAdmin, async (req, res, next) => {
  try {
    const game = await Game.findOne({ id: req.params.id }).lean();
    
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }
    
    // Add stats
    const [raceCount, tournamentCount] = await Promise.all([
      Race.countDocuments({ category: game.integrations?.racetime?.gameSlug || game.id }),
      Tournament.countDocuments({ $or: [{ game: game._id }, { gameId: game.id }] })
    ]);
    
    res.json({
      ...game,
      _stats: {
        races: raceCount,
        tournaments: tournamentCount
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/games
 * Create a new game
 */
router.post('/games', requireAdmin, async (req, res, next) => {
  try {
    const { id, name, randomizer, ...rest } = req.body;
    const shortName = randomizer?.shortName;
    
    if (!id || !name || !shortName) {
      return res.status(400).json({ 
        error: 'Missing required fields: id, name, randomizer.shortName' 
      });
    }
    
    // Check if ID already exists
    const existing = await Game.findOne({ id });
    if (existing) {
      return res.status(409).json({ error: 'Game with this ID already exists' });
    }
    
    const game = new Game({
      id,
      name,
      randomizer,
      ...rest,
      source: {
        origin: 'manual',
        importedAt: new Date()
      }
    });
    
    await game.save();
    
    res.status(201).json(game);
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/admin/games/:id
 * Update a game (full replacement of provided fields)
 */
router.put('/games/:id', requireAdmin, async (req, res, next) => {
  try {
    const { _id, id, ...updateData } = req.body;
    
    // Prevent changing the ID
    if (id && id !== req.params.id) {
      return res.status(400).json({ error: 'Cannot change game ID' });
    }
    
    const game = await Game.findOneAndUpdate(
      { id: req.params.id },
      { $set: updateData },
      { new: true, runValidators: true }
    );
    
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }
    
    res.json(game);
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/admin/games/:id
 * Partial update of a game
 */
router.patch('/games/:id', requireAdmin, async (req, res, next) => {
  try {
    const updates = {};
    
    // Flatten nested objects for $set
    function flattenObject(obj, prefix = '') {
      for (const [key, value] of Object.entries(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        
        if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
          flattenObject(value, fullKey);
        } else {
          updates[fullKey] = value;
        }
      }
    }
    
    flattenObject(req.body);
    
    // Remove protected fields
    delete updates._id;
    delete updates.id;
    
    const game = await Game.findOneAndUpdate(
      { id: req.params.id },
      { $set: updates },
      { new: true, runValidators: true }
    );
    
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }
    
    res.json(game);
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/admin/games/:id
 * Delete a game (soft delete by default)
 */
router.delete('/games/:id', requireAdmin, async (req, res, next) => {
  try {
    const { hard } = req.query;
    
    if (hard === 'true') {
      // Hard delete
      const result = await Game.deleteOne({ id: req.params.id });
      if (result.deletedCount === 0) {
        return res.status(404).json({ error: 'Game not found' });
      }
    } else {
      // Soft delete (disable)
      const game = await Game.findOneAndUpdate(
        { id: req.params.id },
        { $set: { enabled: false } },
        { new: true }
      );
      if (!game) {
        return res.status(404).json({ error: 'Game not found' });
      }
    }
    
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// ==================== RESOURCES MANAGEMENT ====================

/**
 * GET /api/admin/games/:id/resources
 * Get game resources with edit history
 */
router.get('/games/:id/resources', requireAdmin, async (req, res, next) => {
  try {
    const game = await Game.findOne({ id: req.params.id })
      .select('resources randomizer.website integrations.randoList')
      .lean();
    
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }
    
    res.json({
      resources: game.resources || {},
      legacyWebsite: game.randomizer?.website,
      randoListInfo: game.integrations?.randoList
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/admin/games/:id/resources
 * Replace all resources for a game
 */
router.put('/games/:id/resources', requireAdmin, async (req, res, next) => {
  try {
    const { officialSite, sites, trackers, guides, other } = req.body;
    
    const resources = {};
    
    if (officialSite !== undefined) resources.officialSite = officialSite;
    if (sites !== undefined) resources.sites = sites;
    if (trackers !== undefined) resources.trackers = trackers;
    if (guides !== undefined) resources.guides = guides;
    if (other !== undefined) resources.other = other;
    
    const game = await Game.findOneAndUpdate(
      { id: req.params.id },
      { $set: { resources } },
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

/**
 * PATCH /api/admin/games/:id/resources/official-site
 * Update only the official site
 */
router.patch('/games/:id/resources/official-site', requireAdmin, async (req, res, next) => {
  try {
    const { url, name, isArchipelago } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    const game = await Game.findOneAndUpdate(
      { id: req.params.id },
      { 
        $set: { 
          'resources.officialSite': {
            url,
            name: name || 'Site officiel',
            isArchipelago: isArchipelago || false
          }
        } 
      },
      { new: true }
    );
    
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }
    
    res.json({ success: true, officialSite: game.resources?.officialSite });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/games/:id/resources/trackers
 * Add a tracker
 */
router.post('/games/:id/resources/trackers', requireAdmin, async (req, res, next) => {
  try {
    const { url, name, description } = req.body;
    
    if (!url || !name) {
      return res.status(400).json({ error: 'URL and name are required' });
    }
    
    const game = await Game.findOneAndUpdate(
      { id: req.params.id },
      { 
        $push: { 
          'resources.trackers': {
            url,
            name,
            description: description || '',
            source: 'manual'
          }
        } 
      },
      { new: true }
    );
    
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }
    
    res.json({ success: true, trackers: game.resources?.trackers });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/admin/games/:id/resources/trackers/:index
 * Remove a tracker by index
 */
router.delete('/games/:id/resources/trackers/:index', requireAdmin, async (req, res, next) => {
  try {
    const index = parseInt(req.params.index);
    
    const game = await Game.findOne({ id: req.params.id });
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }
    
    if (!game.resources?.trackers || index >= game.resources.trackers.length) {
      return res.status(404).json({ error: 'Tracker not found' });
    }
    
    game.resources.trackers.splice(index, 1);
    await game.save();
    
    res.json({ success: true, trackers: game.resources.trackers });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/games/:id/resources/guides
 * Add a guide
 */
router.post('/games/:id/resources/guides', requireAdmin, async (req, res, next) => {
  try {
    const { url, name, description, type = 'guide' } = req.body;
    
    if (!url || !name) {
      return res.status(400).json({ error: 'URL and name are required' });
    }
    
    const validTypes = ['guide', 'tutorial', 'wiki', 'video'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: `Type must be one of: ${validTypes.join(', ')}` });
    }
    
    const game = await Game.findOneAndUpdate(
      { id: req.params.id },
      { 
        $push: { 
          'resources.guides': {
            url,
            name,
            description: description || '',
            type,
            source: 'manual'
          }
        } 
      },
      { new: true }
    );
    
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }
    
    res.json({ success: true, guides: game.resources?.guides });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/admin/games/:id/resources/guides/:index
 * Remove a guide by index
 */
router.delete('/games/:id/resources/guides/:index', requireAdmin, async (req, res, next) => {
  try {
    const index = parseInt(req.params.index);
    
    const game = await Game.findOne({ id: req.params.id });
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }
    
    if (!game.resources?.guides || index >= game.resources.guides.length) {
      return res.status(404).json({ error: 'Guide not found' });
    }
    
    game.resources.guides.splice(index, 1);
    await game.save();
    
    res.json({ success: true, guides: game.resources.guides });
  } catch (error) {
    next(error);
  }
});

// ==================== INTEGRATIONS ====================

/**
 * PATCH /api/admin/games/:id/integrations/racetime
 * Update racetime integration
 */
router.patch('/games/:id/integrations/racetime', requireAdmin, async (req, res, next) => {
  try {
    const { enabled, gameSlug, gameName } = req.body;
    
    const updates = {};
    if (enabled !== undefined) updates['integrations.racetime.enabled'] = enabled;
    if (gameSlug !== undefined) updates['integrations.racetime.gameSlug'] = gameSlug;
    if (gameName !== undefined) updates['integrations.racetime.gameName'] = gameName;
    updates['integrations.racetime.confidence'] = 'manual';
    
    const game = await Game.findOneAndUpdate(
      { id: req.params.id },
      { $set: updates },
      { new: true }
    );
    
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }
    
    res.json({ success: true, racetime: game.integrations?.racetime });
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/admin/games/:id/integrations/rando-list
 * Update rando-list integration
 */
router.patch('/games/:id/integrations/rando-list', requireAdmin, async (req, res, next) => {
  try {
    const { enabled, randomizerIdentifier, gameName, seriesFile } = req.body;
    
    const updates = {};
    if (enabled !== undefined) updates['integrations.randoList.enabled'] = enabled;
    if (randomizerIdentifier !== undefined) updates['integrations.randoList.randomizerIdentifier'] = randomizerIdentifier;
    if (gameName !== undefined) updates['integrations.randoList.gameName'] = gameName;
    if (seriesFile !== undefined) updates['integrations.randoList.seriesFile'] = seriesFile;
    updates['integrations.randoList.confidence'] = 'manual';
    
    const game = await Game.findOneAndUpdate(
      { id: req.params.id },
      { $set: updates },
      { new: true }
    );
    
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }
    
    res.json({ success: true, randoList: game.integrations?.randoList });
  } catch (error) {
    next(error);
  }
});

// ==================== STATS & UTILITIES ====================

/**
 * GET /api/admin/stats
 * Get overall statistics
 */
router.get('/stats', requireAdmin, async (req, res, next) => {
  try {
    const [
      totalGames,
      enabledGames,
      totalRaces,
      totalTournaments,
      totalPlayers
    ] = await Promise.all([
      Game.countDocuments(),
      Game.countDocuments({ enabled: { $ne: false } }),
      Race.countDocuments(),
      Tournament.countDocuments(),
      Player.countDocuments()
    ]);
    
    // Get games with missing resources
    const gamesNeedingResources = await Game.countDocuments({
      enabled: { $ne: false },
      $or: [
        { 'resources.officialSite': { $exists: false } },
        { 'resources.officialSite.url': { $exists: false } }
      ]
    });
    
    // Get games with multiple sites (need manual official site selection)
    const gamesWithMultipleSites = await Game.countDocuments({
      enabled: { $ne: false },
      'resources.sites.1': { $exists: true },
      $or: [
        { 'resources.officialSite': { $exists: false } },
        { 'resources.officialSite.url': { $exists: false } }
      ]
    });
    
    res.json({
      games: {
        total: totalGames,
        enabled: enabledGames,
        needingResources: gamesNeedingResources,
        needingOfficialSite: gamesWithMultipleSites
      },
      races: totalRaces,
      tournaments: totalTournaments,
      players: totalPlayers
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/sync/rando-list
 * Trigger rando-list sync
 */
router.post('/sync/rando-list', requireAdmin, async (req, res, next) => {
  try {
    const { spawn } = require('child_process');
    const path = require('path');
    
    const scriptPath = path.join(__dirname, '..', 'scripts', 'sync-rando-list-v3.js');
    const args = req.body.linkGames ? ['--link-games'] : [];
    
    const child = spawn('node', [scriptPath, ...args], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    
    res.json({ 
      success: true, 
      message: 'Sync started in background',
      pid: child.pid
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/sync/racetime/:gameId
 * Trigger racetime sync for a specific game
 */
router.post('/sync/racetime/:gameId', requireAdmin, async (req, res, next) => {
  try {
    const { spawn } = require('child_process');
    const path = require('path');
    
    const scriptPath = path.join(__dirname, '..', 'scripts', 'sync-racetime-game.js');
    const args = ['--game', req.params.gameId];
    
    if (req.body.maxPages) {
      args.push('--max-pages', String(req.body.maxPages));
    }
    
    const child = spawn('node', [scriptPath, ...args], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    
    res.json({ 
      success: true, 
      message: `Sync started for ${req.params.gameId}`,
      pid: child.pid
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
