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
const { Game, Tournament, Match, Race, Player } = require('../models');

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
 * POST /api/admin/games/:id/change-id
 * Change a game's ID and update all references
 */
router.post('/games/:id/change-id', requireAdmin, async (req, res, next) => {
  try {
    const { newId } = req.body;
    const oldId = req.params.id;
    
    if (!newId) {
      return res.status(400).json({ error: 'newId is required' });
    }
    
    if (!/^[a-z0-9-]+$/.test(newId)) {
      return res.status(400).json({ error: 'ID must contain only lowercase letters, numbers and hyphens' });
    }
    
    if (newId === oldId) {
      return res.json({ success: true, message: 'ID unchanged' });
    }
    
    // Check if new ID already exists
    const existing = await Game.findOne({ id: newId });
    if (existing) {
      return res.status(409).json({ error: `A game with ID "${newId}" already exists` });
    }
    
    // Find the game
    const game = await Game.findOne({ id: oldId });
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }
    
    // Update the game ID directly in MongoDB (bypass immutable)
    await Game.collection.updateOne(
      { _id: game._id },
      { $set: { id: newId } }
    );
    
    // Update references in tournaments
    await Tournament.updateMany(
      { gameId: oldId },
      { $set: { gameId: newId } }
    );
    
    // Update references in tournaments by gameSlug
    await Tournament.updateMany(
      { gameSlug: oldId },
      { $set: { gameSlug: newId } }
    );
    
    // Update references in races
    await Race.updateMany(
      { category: oldId },
      { $set: { category: newId } }
    );
    
    res.json({ 
      success: true, 
      message: `Game ID changed from "${oldId}" to "${newId}"`,
      oldId,
      newId
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/games/:id/merge
 * Merge a source game into this target game (resources combined, source deleted)
 */
router.post('/games/:id/merge', requireAdmin, async (req, res, next) => {
  try {
    const { sourceId } = req.body;
    const targetId = req.params.id;
    
    if (!sourceId) {
      return res.status(400).json({ error: 'sourceId is required' });
    }
    
    if (sourceId === targetId) {
      return res.status(400).json({ error: 'Cannot merge a game with itself' });
    }
    
    const [target, source] = await Promise.all([
      Game.findOne({ id: targetId }),
      Game.findOne({ id: sourceId })
    ]);
    
    if (!target) {
      return res.status(404).json({ error: 'Target game not found' });
    }
    if (!source) {
      return res.status(404).json({ error: `Source game "${sourceId}" not found` });
    }
    
    // Initialize resources if needed
    if (!target.resources) target.resources = {};
    const sourceResources = source.resources || {};
    let mergedCount = 0;
    
    // Merge official site (only if target doesn't have one)
    if (!target.resources.officialSite?.url && sourceResources.officialSite?.url) {
      target.resources.officialSite = sourceResources.officialSite;
      mergedCount++;
    }
    
    // Merge sites (add non-duplicate URLs)
    if (sourceResources.sites?.length > 0) {
      if (!target.resources.sites) target.resources.sites = [];
      const existingUrls = new Set(target.resources.sites.map(s => s.url));
      for (const site of sourceResources.sites) {
        if (!existingUrls.has(site.url)) {
          target.resources.sites.push(site);
          existingUrls.add(site.url);
          mergedCount++;
        }
      }
    }
    
    // Merge trackers (add non-duplicate URLs)
    if (sourceResources.trackers?.length > 0) {
      if (!target.resources.trackers) target.resources.trackers = [];
      const existingUrls = new Set(target.resources.trackers.map(t => t.url));
      for (const tracker of sourceResources.trackers) {
        if (!existingUrls.has(tracker.url)) {
          target.resources.trackers.push(tracker);
          existingUrls.add(tracker.url);
          mergedCount++;
        }
      }
    }
    
    // Merge guides (add non-duplicate URLs)
    if (sourceResources.guides?.length > 0) {
      if (!target.resources.guides) target.resources.guides = [];
      const existingUrls = new Set(target.resources.guides.map(g => g.url));
      for (const guide of sourceResources.guides) {
        if (!existingUrls.has(guide.url)) {
          target.resources.guides.push(guide);
          existingUrls.add(guide.url);
          mergedCount++;
        }
      }
    }
    
    // Merge other resources
    if (sourceResources.other?.length > 0) {
      if (!target.resources.other) target.resources.other = [];
      const existingUrls = new Set(target.resources.other.map(o => o.url));
      for (const other of sourceResources.other) {
        if (!existingUrls.has(other.url)) {
          target.resources.other.push(other);
          existingUrls.add(other.url);
          mergedCount++;
        }
      }
    }
    
    // Save target with merged resources
    target.markModified('resources');
    await target.save();
    
    // Update references from source to target
    const sourceGameSlug = source.integrations?.racetime?.gameSlug;
    
    // Update tournaments
    await Tournament.updateMany(
      { $or: [{ gameId: sourceId }, { gameSlug: sourceId }, { game: source._id }] },
      { $set: { gameId: targetId, gameSlug: targetId, game: target._id } }
    );
    
    // Update races referencing the source game
    if (sourceGameSlug) {
      await Race.updateMany(
        { category: sourceGameSlug },
        { $set: { category: target.integrations?.racetime?.gameSlug || targetId } }
      );
    }
    await Race.updateMany(
      { category: sourceId },
      { $set: { category: targetId } }
    );
    
    // Delete the source game
    await Game.deleteOne({ _id: source._id });
    
    res.json({ 
      success: true, 
      message: `Game "${sourceId}" merged into "${targetId}" and deleted`,
      mergedResources: mergedCount
    });
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
    const { url, name, isArchipelago, isMultiworld } = req.body;
    
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
            isArchipelago: isArchipelago || false,
            isMultiworld: isMultiworld || false
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
      totalTournaments
    ] = await Promise.all([
      Game.countDocuments(),
      Game.countDocuments({ enabled: { $ne: false } }),
      Race.countDocuments(),
      Tournament.countDocuments()
    ]);

    // Count unique players by entrants.userId from races (preferred source)
    let totalPlayers = 0;
    try {
      const playerIds = await Race.distinct('entrants.userId', { 'entrants.userId': { $exists: true, $ne: null } });
      totalPlayers = (playerIds && playerIds.length) ? playerIds.length : await Player.countDocuments();
    } catch (e) {
      // Fallback to Player collection if something goes wrong
      totalPlayers = await Player.countDocuments();
    }

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

// ==================== PLAYERS ADMIN ====================

/**
 * GET /api/admin/players
 * List all players with full aggregated data (from tournaments and races)
 */
router.get('/players', requireAdmin, async (req, res, next) => {
  try {
    const { search, limit = 50, page = 1 } = req.query;
    
    // Get all tournaments with participants
    const tournaments = await Tournament.find({}).lean();
    
    // Get all Player documents (for racetime/twitch info)
    const playerDocs = await Player.find({}).lean();
    const playerDocsByUserId = new Map();
    playerDocs.forEach(p => {
      if (p.userId) playerDocsByUserId.set(p.userId, p);
    });
    
    // Get all races to count per player
    const races = await Race.find({}, { category: 1, entrants: 1 }).lean();
    
    // Build player data from races
    const playersMap = new Map(); // userId -> player data
    
    races.forEach(race => {
      if (race.entrants && Array.isArray(race.entrants)) {
        race.entrants.forEach(entrant => {
          const userId = entrant.userId;
          const userName = entrant.userName || userId;
          if (!userId) return;
          
          if (!playersMap.has(userId)) {
            const playerDoc = playerDocsByUserId.get(userId);
            playersMap.set(userId, {
              userId,
              name: playerDoc?.name || userName,
              racetimeUrl: playerDoc?.racetimeUrl || `https://racetime.gg/user/${userId}`,
              twitch: playerDoc?.twitch || null,
              stats: {
                totalRaces: 0,
                totalWins: 0
              }
            });
          }
          
          const player = playersMap.get(userId);
          player.stats.totalRaces++;
          
          // Count wins (place 1 or placeOrdinal '1st')
          if (entrant.place === 1 || entrant.placeOrdinal === '1st') {
            player.stats.totalWins++;
          }
        });
      }
    });
    
    // Add tournament participants who might not be in races
    tournaments.forEach(tournament => {
      if (tournament.participants && Array.isArray(tournament.participants)) {
        tournament.participants.forEach(participant => {
          // Use challongeId or name to try to find userId
          // This is a fallback for tournament-only players
        });
      }
    });
    
    // Convert to array and filter by search
    let players = Array.from(playersMap.values());
    
    if (search) {
      const searchLower = search.toLowerCase();
      players = players.filter(p => 
        p.name.toLowerCase().includes(searchLower) ||
        (p.userId && p.userId.toLowerCase().includes(searchLower)) ||
        (p.twitch && p.twitch.toLowerCase().includes(searchLower))
      );
    }
    
    // Sort by name
    players.sort((a, b) => a.name.localeCompare(b.name));
    
    const total = players.length;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const paginatedPlayers = players.slice(skip, skip + parseInt(limit));
    
    // Calculate stats
    const withRacetime = players.filter(p => p.racetimeUrl).length;
    const withTwitch = players.filter(p => p.twitch).length;
    
    res.json({
      players: paginatedPlayers,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit))
      },
      stats: {
        total,
        withRacetime,
        withTwitch
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/players/:id
 * Get single player by userId
 */
router.get('/players/:id', requireAdmin, async (req, res, next) => {
  try {
    // Players use userId (racetime ID) as primary identifier, not MongoDB _id
    const player = await Player.findOne({ userId: req.params.id }).lean();
    
    if (!player) {
      return res.status(404).json({ error: 'Player not found' });
    }
    
    res.json(player);
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/admin/players/:id
 * Update a player by userId
 */
router.put('/players/:id', requireAdmin, async (req, res, next) => {
  try {
    const { name, racetimeUrl, twitch } = req.body;
    
    // Players use userId (racetime ID) as primary identifier
    const player = await Player.findOneAndUpdate(
      { userId: req.params.id },
      { 
        $set: { 
          name,
          racetimeUrl,
          twitch
        } 
      },
      { new: true }
    );
    
    if (!player) {
      return res.status(404).json({ error: 'Player not found' });
    }
    
    res.json(player);
  } catch (error) {
    next(error);
  }
});

// ==================== SYNC HISTORY ====================

/**
 * GET /api/admin/sync/history
 * Get sync history (stored in memory or file for now)
 */
router.get('/sync/history', requireAdmin, async (req, res, next) => {
  try {
    // For now, check game lastSync dates as a proxy for sync history
    const games = await Game.find({ 
      'integrations.racetime.enabled': true 
    }).select('id name integrations.racetime.lastSync').lean();
    
    const history = games
      .filter(g => g.integrations?.racetime?.lastSync)
      .map(g => ({
        type: `Racetime: ${g.name}`,
        status: 'success',
        completedAt: g.integrations.racetime.lastSync
      }))
      .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt))
      .slice(0, 20);
    
    res.json({ history });
  } catch (error) {
    next(error);
  }
});

// ==================== HEALTH & MONITORING ====================

/**
 * GET /api/admin/health
 * Get system health status
 */
router.get('/health', requireAdmin, async (req, res, next) => {
  try {
    const mongoose = require('mongoose');
    const os = require('os');
    
    // Database status
    const dbStatus = mongoose.connection.readyState === 1 ? 'ok' : 'error';
    
    // Get last sync dates
    const lastRacetimeSync = await Game.findOne({ 
      'integrations.racetime.lastSync': { $exists: true } 
    }).sort({ 'integrations.racetime.lastSync': -1 }).lean();
    
    const lastRandoListSync = await Game.findOne({ 
      'integrations.randoList.lastSync': { $exists: true } 
    }).sort({ 'integrations.randoList.lastSync': -1 }).lean();
    
    // System info
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    
    // Check if running under PM2
    let pm2Info = null;
    if (process.env.PM2_HOME || process.env.pm_id) {
      pm2Info = {
        status: 'online',
        restarts: parseInt(process.env.restart_time || '0'),
        cpu: process.cpuUsage ? Math.round(process.cpuUsage().user / 1000000) : 0,
        memory: formatBytes(process.memoryUsage().heapUsed)
      };
    }
    
    // Test racetime.gg connectivity
    let racetimeStatus = 'unknown';
    try {
      const axios = require('axios');
      const raceResp = await axios.get('https://racetime.gg/health', { timeout: 5000 });
      racetimeStatus = raceResp.status === 200 ? 'ok' : 'error';
    } catch (e) {
      // Try simple request
      try {
        const axios = require('axios');
        await axios.get('https://racetime.gg/', { timeout: 5000 });
        racetimeStatus = 'ok';
      } catch {
        racetimeStatus = 'error';
      }
    }
    
    // Test Twitch API connectivity
    let twitchStatus = 'unknown';
    try {
      const axios = require('axios');
      await axios.get('https://id.twitch.tv/oauth2/validate', { timeout: 5000, validateStatus: () => true });
      twitchStatus = 'ok';
    } catch {
      twitchStatus = 'error';
    }
    
    // Test Challonge API connectivity
    let challongeStatus = 'unknown';
    try {
      const axios = require('axios');
      const challResp = await axios.get('https://api.challonge.com/v1/tournaments.json', { 
        timeout: 5000, 
        validateStatus: () => true 
      });
      // 401 means the API is reachable (just no auth)
      challongeStatus = (challResp.status === 200 || challResp.status === 401) ? 'ok' : 'error';
    } catch {
      challongeStatus = 'error';
    }
    
    // Test start.gg (smash.gg) API connectivity
    let startggStatus = 'unknown';
    try {
      const axios = require('axios');
      const sgResp = await axios.post('https://api.start.gg/gql/alpha', 
        { query: '{ __typename }' },
        { timeout: 5000, validateStatus: () => true }
      );
      startggStatus = (sgResp.status === 200 || sgResp.status === 400 || sgResp.status === 401) ? 'ok' : 'error';
    } catch {
      startggStatus = 'error';
    }
    
    res.json({
      api: { status: 'ok', description: 'API du site Randomizer' },
      database: { status: dbStatus },
      racetime: { status: racetimeStatus },
      twitch: { status: twitchStatus },
      challonge: { status: challongeStatus },
      startgg: { status: startggStatus },
      system: {
        uptime: process.uptime(),
        nodeVersion: process.version,
        memory: {
          total: formatBytes(totalMem),
          used: formatBytes(usedMem),
          free: formatBytes(freeMem)
        }
      },
      pm2: pm2Info,
      lastSync: {
        racetime: lastRacetimeSync?.integrations?.racetime?.lastSync,
        randoList: lastRandoListSync?.integrations?.randoList?.lastSync
      }
    });
  } catch (error) {
    next(error);
  }
});

// Helper function
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// ==================== GITHUB WORKFLOWS ====================

/**
 * GET /api/admin/github/workflows
 * Get latest run status for each GitHub Actions workflow
 */
router.get('/github/workflows', requireAdmin, async (req, res, next) => {
  try {
    const githubToken = process.env.GITHUB_TOKEN;
    const githubRepo = process.env.GITHUB_REPO || 'queled/randomizer.games';
    
    if (!githubToken) {
      return res.status(501).json({ error: 'GITHUB_TOKEN not configured' });
    }
    
    const axios = require('axios');
    
    // Fetch the latest runs for each of our 3 workflows
    const workflowFiles = [
      'sync-racetime.yml',
      'sync-rando-list.yml',
      'sync-racetime-game-full.yml'
    ];
    
    const workflowResults = await Promise.all(
      workflowFiles.map(async (wfFile) => {
        try {
          const resp = await axios.get(
            `https://api.github.com/repos/${githubRepo}/actions/workflows/${wfFile}/runs?per_page=1`,
            {
              headers: {
                'Authorization': `token ${githubToken}`,
                'Accept': 'application/vnd.github.v3+json'
              },
              timeout: 10000
            }
          );
          
          const run = resp.data.workflow_runs?.[0];
          if (!run) return { name: wfFile, status: 'no_runs', conclusion: null, event: null, updated_at: null };
          
          return {
            name: run.name || wfFile,
            status: run.status,
            conclusion: run.conclusion,
            event: run.event,
            updated_at: run.updated_at,
            html_url: run.html_url
          };
        } catch (e) {
          return { name: wfFile, status: 'error', conclusion: 'error', event: null, updated_at: null };
        }
      })
    );
    
    res.json({ workflows: workflowResults });
  } catch (error) {
    next(error);
  }
});

// ==================== RACE-MATCH LINKING ====================

const {
  scoreRaceAgainstMatch,
  rankMatchesForRace,
  selectBestCandidate,
  getMatchPlayers,
  extractRaceEntrants,
  getRaceLabel,
  parseRaceStageInfo
} = require('../helpers/race-match-linking');
const racetimeAPI = require('../services/racetime');
const {
  loadNormalizedMatches,
  loadCandidateRaces,
  buildAutoLinkPreview,
  applyAutoLinkProposals
} = require('../services/tournament-autolink');

/**
 * Parse a racetime URL to extract category and raceId.
 * Accepts: https://racetime.gg/ootr/chaotic-volvagia-4238, /ootr/chaotic-volvagia-4238, ootr/chaotic-volvagia-4238
 * Returns { category, raceId, normalizedUrl } or null
 */
function parseRacetimeUrl(url) {
  if (!url) return null;
  const cleaned = url.replace(/^https?:\/\/(www\.)?racetime\.gg/, '').replace(/^\/+/, '');
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return { category: parts[0], raceId: parts[1], normalizedUrl: `/${parts[0]}/${parts[1]}` };
}

/**
 * GET /api/admin/tournaments
 * List tournaments for race linking
 */
router.get('/tournaments', requireAdmin, async (req, res, next) => {
  try {
    const { search, limit = 30, page = 1 } = req.query;
    const query = {};

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { gameName: { $regex: search, $options: 'i' } }
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [tournaments, total] = await Promise.all([
      Tournament.find(query)
        .populate('game', 'id name')
        .sort({ startDate: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .select('name gameName gameId startDate endDate startggId challongeId participantsCount matches setsTotal game')
        .lean(),
      Tournament.countDocuments(query)
    ]);

    const challongeTournamentIds = tournaments
      .filter(t => !!t.challongeId)
      .map(t => t._id);

    const challongeCounts = challongeTournamentIds.length
      ? await Match.aggregate([
        { $match: { tournamentId: { $in: challongeTournamentIds } } },
        { $group: { _id: '$tournamentId', count: { $sum: 1 } } }
      ])
      : [];

    const challongeCountMap = new Map(
      challongeCounts.map(entry => [String(entry._id), entry.count])
    );

    const results = tournaments.map(t => ({
      _id: t._id,
      name: t.name,
      gameName: t.gameName || t.game?.name || t.gameId || '-',
      startDate: t.startDate,
      endDate: t.endDate,
      isStartgg: !!t.startggId,
      isChallonge: !!t.challongeId,
      participantsCount: t.participantsCount || 0,
      matchesCount: t.startggId
        ? (t.matches?.length || 0)
        : (challongeCountMap.get(String(t._id)) || 0)
    }));

    res.json({
      tournaments: results,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/tournaments/:id/linking
 * Get tournament matches and races with linking status
 */
router.get('/tournaments/:id/linking', requireAdmin, async (req, res, next) => {
  try {
    const tournament = await Tournament.findById(req.params.id)
      .populate('game')
      .lean();
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    const matches = await loadNormalizedMatches({ tournament, Match });
    const isStartgg = !!tournament.startggId;

    // Get races for this tournament, including nearby candidates useful for auto-link/admin.
    const races = (await loadCandidateRaces({ tournament, Race, matches }))
      .filter(r => !['pending', 'cancelled'].includes(r.status))
      .sort((a, b) => new Date(b.startedAt || 0).getTime() - new Date(a.startedAt || 0).getTime());

    // Reconstruct raceUrl/raceUrls from Race documents for matches that lost
    // their embedded link data (e.g. after tournament sync overwrote matches array).
    // This uses startggSetId (for start.gg) or matchId (for Challonge) on Race docs.
    const raceByMatch = new Map(); // matchId/setId → [raceUrl, ...] (sorted chronologically)
    for (const r of races) {
      const key = r.startggSetId ? String(r.startggSetId) : (r.matchId ? String(r.matchId) : null);
      if (!key || !r.url) continue;
      if (!raceByMatch.has(key)) raceByMatch.set(key, []);
      raceByMatch.get(key).push({ url: r.url, startedAt: r.startedAt });
    }
    // Sort each group chronologically (oldest first)
    for (const [, arr] of raceByMatch) {
      arr.sort((a, b) => new Date(a.startedAt || 0).getTime() - new Date(b.startedAt || 0).getTime());
    }

    for (const m of matches) {
      const key = m.startggSetId ? String(m.startggSetId) : String(m._id);
      const fromRaces = raceByMatch.get(key);
      if (!fromRaces || !fromRaces.length) continue;

      const raceUrls = fromRaces.map(r => r.url);
      // If embedded match already has links, keep them (preserve manual ordering);
      // otherwise reconstruct from Race documents.
      if (!m.raceUrl && (!m.raceUrls || !m.raceUrls.length)) {
        m.raceUrls = raceUrls;
        m.raceUrl = raceUrls[0];
      }
    }

    // Sort matches: by phase, then by round (winners first), then chronologically
    matches.sort((a, b) => {
      // Same phase grouping
      if (a.phase !== b.phase) return (a.phase || '').localeCompare(b.phase || '');
      // Round: positive rounds ascending, negative (losers) after positives
      const ra = a.round || 0;
      const rb = b.round || 0;
      if (ra !== rb) {
        if (ra >= 0 && rb >= 0) return ra - rb;
        if (ra < 0 && rb < 0) return ra - rb; // both losers: closer to 0 = earlier
        return ra >= 0 ? -1 : 1; // winners before losers
      }
      // Then by completedAt
      const ta = a.completedAt ? new Date(a.completedAt).getTime() : 0;
      const tb = b.completedAt ? new Date(b.completedAt).getTime() : 0;
      return ta - tb;
    });

    const tournamentIdStr = String(tournament._id);
    const racesFormatted = races.map(r => {
      const stageInfo = parseRaceStageInfo(r);
      const extracted = extractRaceEntrants(r, { requireDirect: false });
      return {
        _id: r._id.toString(),
        url: r.url,
        name: r.name,
        info: (r.info || '').split('\n')[0].substring(0, 120),
        label: getRaceLabel(r),
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        entrantCount: (r.entrants || []).length,
        entrantNames: extracted.entrants.map(e => e.name).slice(0, 4),
        matchId: r.matchId?.toString() || null,
        startggSetId: r.startggSetId || null,
        matchConfidence: r.matchConfidence || null,
        matchPlayers: r.matchPlayers || null,
        status: r.status || null,
        stageType: stageInfo.type,
        isQualifier: stageInfo.type === 'qualifier',
        isLinked: !!(r.matchId || r.startggSetId),
        isAttached: !!r.tournamentId && String(r.tournamentId) === tournamentIdStr
      };
    });

    // Compute stats
    const linkedRaces = racesFormatted.filter(r => r.isLinked).length;
    const qualifierRaces = racesFormatted.filter(r => r.isQualifier).length;
    const linkedMatches = matches.filter(m => m.raceUrl || (m.raceUrls && m.raceUrls.length > 0)).length;
    // Only count races attached to this tournament (not nearby candidates) as "unlinked"
    const attachedUnlinked = racesFormatted.filter(r => r.isAttached && !r.isLinked && !r.isQualifier).length;

    // Get phases for start.gg tournaments
    const phases = isStartgg && Array.isArray(tournament.phases) ? tournament.phases : [];

    res.json({
      tournament: {
        _id: tournament._id,
        name: tournament.name,
        gameName: tournament.gameName || tournament.gameId,
        isStartgg,
        isChallonge: !!tournament.challongeId,
        startDate: tournament.startDate,
        endDate: tournament.endDate
      },
      matches,
      races: racesFormatted,
      phases,
      stats: {
        totalMatches: matches.length,
        linkedMatches,
        unlinkedMatches: matches.length - linkedMatches,
        totalRaces: racesFormatted.length,
        linkedRaces,
        unlinkedRaces: attachedUnlinked,
        qualifierRaces
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/tournaments/:id/suggestions/:matchId
 * Get race suggestions for a specific match using heuristic scoring
 */
router.get('/tournaments/:id/suggestions/:matchId', requireAdmin, async (req, res, next) => {
  try {
    const tournament = await Tournament.findById(req.params.id)
      .populate('game')
      .lean();
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    // Find the match
    let match = null;
    const isStartgg = !!tournament.startggId;

    if (isStartgg && Array.isArray(tournament.matches)) {
      const embedded = tournament.matches.find(m =>
        (m.startggSetId || '').toString() === req.params.matchId ||
        (m._id || '').toString() === req.params.matchId
      );
      if (embedded) {
        match = {
          ...embedded,
          player1Name: embedded.player1?.name,
          player2Name: embedded.player2?.name
        };
      }
    } else {
      match = await Match.findById(req.params.matchId).lean();
    }

    if (!match) return res.status(404).json({ error: 'Match not found' });

    // Skip TBD matches — no players determined yet
    const p1Name = match.player1Name || match.player1?.name || '';
    const p2Name = match.player2Name || match.player2?.name || '';
    if (!p1Name || !p2Name || p1Name === 'TBD' || p2Name === 'TBD') {
      return res.json({ matchId: req.params.matchId, player1: p1Name || 'TBD', player2: p2Name || 'TBD', suggestions: [] });
    }

    // Get all linkable races for this tournament (exclude pending & cancelled)
    const matches = await loadNormalizedMatches({ tournament, Match });
    const races = (await loadCandidateRaces({ tournament, Race, matches }))
      .filter(race => !['pending', 'cancelled'].includes(race.status))
      .filter(race => !race.tournamentId || String(race.tournamentId) === String(tournament._id) || !(race.matchId || race.startggSetId));

    // Score each race against this match
    const suggestions = [];
    for (const race of races) {
      const extracted = extractRaceEntrants(race, { requireDirect: false });

      const result = scoreRaceAgainstMatch(race, match, {
        requireDirect: false,
        allowOccupiedMatchReassign: true,
        skipOccupiedPenalty: true  // In suggestions, we want to show all candidates for BO
      });

      if (result.score > 0) {
        suggestions.push({
          raceId: race._id.toString(),
          raceUrl: race.url,
          label: getRaceLabel(race),
          entrantCount: (race.entrants || []).length,
          entrantNames: extracted.entrants.map(e => e.name).slice(0, 4),
          startedAt: race.startedAt,
          endedAt: race.endedAt,
          score: result.score,
          reason: result.reason,
          isAlreadyLinked: !!(race.matchId || race.startggSetId),
          matchPlayers: race.matchPlayers || null,
          status: race.status || null,
          stageType: parseRaceStageInfo(race).type
        });
      }
    }

    // Sort by score descending
    suggestions.sort((a, b) => b.score - a.score);

    res.json({
      matchId: req.params.matchId,
      player1: match.player1Name || match.player1?.name || 'TBD',
      player2: match.player2Name || match.player2?.name || 'TBD',
      suggestions: suggestions.slice(0, 20)
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/tournaments/:id/link-race
 * Link a race to a match (manual association)
 * If the race doesn't exist in DB, auto-imports it from racetime.gg
 */
router.post('/tournaments/:id/link-race', requireAdmin, async (req, res, next) => {
  try {
    const { raceUrl, matchId, isQualifier } = req.body;
    if (!raceUrl) return res.status(400).json({ error: 'raceUrl is required' });

    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    // Normalize URL and find race — auto-import from racetime if missing
    const parsed = parseRacetimeUrl(raceUrl);
    const normalizedUrl = parsed ? parsed.normalizedUrl : raceUrl;
    let race = await Race.findOne({ url: normalizedUrl });
    if (!race && parsed) {
      race = await Race.findOne({ url: raceUrl });
    }
    if (!race) {
      if (!parsed) return res.status(404).json({ error: 'Race not found and URL cannot be parsed for import' });
      try {
        const raceData = await racetimeAPI.getRace(parsed.category, parsed.raceId);
        if (!raceData) return res.status(404).json({ error: 'Race not found on racetime.gg' });
        race = await Race.findOneAndUpdate(
          { url: raceData.url || parsed.normalizedUrl },
          { $set: {
            ...raceData,
            url: raceData.url || parsed.normalizedUrl,
            tournamentId: tournament._id,
            source: { type: 'racetime', externalId: parsed.raceId, url: raceData.url || parsed.normalizedUrl, importedAt: new Date() }
          } },
          { upsert: true, new: true }
        );
        for (const entrant of (raceData.entrants || [])) {
          if (entrant.user?.id) {
            await Player.findOneAndUpdate(
              { userId: entrant.user.id },
              { $set: { name: entrant.user.name, discriminator: entrant.user.discriminator, racetimeUrl: entrant.user.url || entrant.user.id } },
              { upsert: true }
            );
          }
        }
      } catch (importErr) {
        console.error('Failed to import race from racetime:', importErr.message);
        return res.status(404).json({ error: `Race not found in DB and import failed: ${importErr.message}` });
      }
    }

    const effectiveRaceUrl = race.url;
    const isStartgg = !!tournament.startggId;

    if (isQualifier) {
      race.tournamentId = tournament._id;
      race.matchId = undefined;
      race.startggSetId = undefined;
      race.matchConfidence = undefined;
      race.matchPlayers = undefined;
      await race.save();
      return res.json({ success: true, message: 'Race linked as qualifier' });
    }

    if (!matchId) return res.status(400).json({ error: 'matchId is required for non-qualifier linking' });

    if (isStartgg) {
      const embeddedMatch = tournament.matches?.find(m =>
        (m.startggSetId || '').toString() === matchId ||
        (m._id || '').toString() === matchId
      );
      if (!embeddedMatch) return res.status(404).json({ error: 'Embedded match not found' });

      const setId = embeddedMatch.startggSetId;

      race.tournamentId = tournament._id;
      race.startggSetId = setId;
      race.matchPlayers = `${embeddedMatch.player1?.name || ''} vs ${embeddedMatch.player2?.name || ''}`.trim();
      race.matchConfidence = 999;
      race.tournamentPhase = embeddedMatch.phase || race.tournamentPhase;
      race.tournamentPool = embeddedMatch.phaseGroup || race.tournamentPool;
      race.tournamentRound = embeddedMatch.round ?? race.tournamentRound;
      await race.save();

      embeddedMatch.raceUrl = effectiveRaceUrl;
      embeddedMatch.linkScore = 999;
      if (!Array.isArray(embeddedMatch.raceUrls)) embeddedMatch.raceUrls = [];
      if (!embeddedMatch.raceUrls.includes(effectiveRaceUrl)) {
        embeddedMatch.raceUrls.push(effectiveRaceUrl);
      }
      tournament.markModified('matches');
      tournament.updatedAt = new Date();
      await tournament.save();
    } else {
      const matchDoc = await Match.findById(matchId);
      if (!matchDoc) return res.status(404).json({ error: 'Match not found' });

      race.tournamentId = tournament._id;
      race.matchId = matchDoc._id;
      race.matchConfidence = 999;
      race.matchPlayers = `${matchDoc.player1Name || ''} vs ${matchDoc.player2Name || ''}`.trim();
      await race.save();

      matchDoc.raceUrl = effectiveRaceUrl;
      matchDoc.completedAt = race.endedAt || matchDoc.completedAt;
      await matchDoc.save();
    }

    res.json({ success: true, message: 'Race linked to match' });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/tournaments/:id/unlink-race
 * Unlink a race from its match
 */
router.post('/tournaments/:id/unlink-race', requireAdmin, async (req, res, next) => {
  try {
    const { raceUrl } = req.body;
    if (!raceUrl) return res.status(400).json({ error: 'raceUrl is required' });

    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    const race = await Race.findOne({ url: raceUrl });
    if (!race) return res.status(404).json({ error: 'Race not found' });

    const isStartgg = !!tournament.startggId;

    if (isStartgg) {
      // Find and clear embedded match (use save() to avoid type-mismatch with arrayFilters)
      const setId = race.startggSetId;
      if (setId) {
        const embeddedMatch = tournament.matches?.find(m =>
          (m.startggSetId || '').toString() === String(setId)
        );
        if (embeddedMatch) {
          embeddedMatch.raceUrls = (embeddedMatch.raceUrls || []).filter(u => u !== raceUrl);
          if (embeddedMatch.raceUrl === raceUrl) {
            embeddedMatch.raceUrl = embeddedMatch.raceUrls[0] || null;
          }
          if (!embeddedMatch.raceUrls.length) {
            embeddedMatch.linkScore = null;
          }
          tournament.markModified('matches');
          tournament.updatedAt = new Date();
          await tournament.save();
        }
      }
    } else {
      // Challonge: clear match raceUrl
      if (race.matchId) {
        await Match.updateOne(
          { _id: race.matchId },
          { $unset: { raceUrl: 1 }, $currentDate: { updatedAt: true } }
        );
      }
    }

    // Clear race linking fields
    race.matchId = undefined;
    race.startggSetId = undefined;
    race.matchConfidence = undefined;
    race.matchPlayers = undefined;
    race.tournamentPhase = undefined;
    race.tournamentPool = undefined;
    race.tournamentRound = undefined;
    await race.save();

    res.json({ success: true, message: 'Race unlinked' });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/tournaments/:id/auto-link-preview
 * Preview auto-link results without applying them
 */
router.get('/tournaments/:id/auto-link-preview', requireAdmin, async (req, res, next) => {
  try {
    const tournament = await Tournament.findById(req.params.id)
      .populate('game')
      .lean();
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    const preview = await buildAutoLinkPreview({
      tournament,
      Match,
      Race,
      threshold: 300,
      minGap: 50
    });

    res.json({
      proposals: preview.proposals,
      skipped: preview.skipped,
      total: preview.total
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/tournaments/:id/auto-link-confirm
 * Apply selected auto-link proposals (batch)
 */
router.post('/tournaments/:id/auto-link-confirm', requireAdmin, async (req, res, next) => {
  try {
    const { proposals } = req.body;
    if (!Array.isArray(proposals) || !proposals.length) {
      return res.status(400).json({ error: 'proposals array is required' });
    }

    const tournament = await Tournament.findById(req.params.id)
      .populate('game');
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    const result = await applyAutoLinkProposals({
      tournament,
      proposals,
      Race,
      Match
    });

    res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/tournaments/:id/reorder-races
 * Reorder races within a match (for BO series)
 */
router.post('/tournaments/:id/reorder-races', requireAdmin, async (req, res, next) => {
  try {
    const { matchId, raceUrls } = req.body;
    if (!matchId || !Array.isArray(raceUrls)) {
      return res.status(400).json({ error: 'matchId and raceUrls[] required' });
    }

    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    const isStartgg = !!tournament.startggId;

    if (isStartgg) {
      // Update embedded match raceUrls order (use save() to avoid type-mismatch with arrayFilters)
      const embeddedMatch = tournament.matches?.find(m =>
        (m.startggSetId || '').toString() === matchId ||
        (m._id || '').toString() === matchId
      );
      if (!embeddedMatch) return res.status(404).json({ error: 'Match not found' });

      embeddedMatch.raceUrls = raceUrls;
      embeddedMatch.raceUrl = raceUrls[0] || null;
      tournament.markModified('matches');
      tournament.updatedAt = new Date();
      await tournament.save();
    }
    // For Challonge, raceUrl is singular so reordering doesn't apply yet

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// ==================== ANALYTICS (placeholder) ====================

/**
 * GET /api/admin/analytics
 * Get site analytics - placeholder for future integration
 */
router.get('/analytics', requireAdmin, async (req, res) => {
  // This is a placeholder - actual implementation would connect to
  // Google Analytics, Plausible, Umami, or similar service
  res.status(501).json({ 
    message: 'Analytics not configured yet',
    hint: 'Configure Google Analytics, Plausible, or Umami when the site goes live'
  });
});

module.exports = router;
