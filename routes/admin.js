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
const { adminLoginLimiter } = require('../middleware/security');
const { Game, Tournament, Match, Race, Player } = require('../models');
const { normalizePlayerName } = require('../helpers/player-aliases');
const { syncParticipantAccounts } = require('../helpers/participant-accounts');
const { fillMissingFinalRanks } = require('../helpers/bracket-ranks');
const { JOBS, getJobsHealth, readJobLog } = require('../services/job-health');
const { computeLinkCoverage, summarizeCoverage } = require('../services/link-coverage');
const { mergeGames, changeGameId } = require('../services/game-merge');
const { invalidateGamesWithStats } = require('./games');
const { readHistory, writeHistory, deleteHistory, renameHistory } = require('../helpers/game-history');
const { coverIds, historyIds, writeCover, deleteCover, renameCover } = require('../helpers/game-covers');
const { calculateTournamentStatus } = require('../helpers/tournament-status');

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Nested objects as dotted paths for $set, so an update only touches the fields it sends
// (arrays and dates are set whole)
function flattenObject(obj, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      flattenObject(value, fullKey, out);
    } else {
      out[fullKey] = value;
    }
  }
  return out;
}

// The games list is cached: any successful game edit refreshes it.
router.use('/games', (req, res, next) => {
  if (req.method !== 'GET') {
    res.on('finish', () => {
      if (res.statusCode < 400) invalidateGamesWithStats();
    });
  }
  next();
});

// ==================== AUTH ====================

/**
 * POST /api/admin/login
 * Login with admin token
 */
router.post('/login', adminLoginLimiter, async (req, res, next) => {
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
  
  let sessionToken;
  try {
    sessionToken = await createSession('admin');
  } catch (error) {
    return next(error);
  }

  // Set cookie for browser
  res.cookie('adminSession', sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  });
  
  res.json({ 
    success: true, 
    expiresIn: 24 * 60 * 60 // seconds
  });
});

/**
 * POST /api/admin/logout
 * Logout and destroy session
 */
router.post('/logout', requireAdmin, async (req, res, next) => {
  try {
    await destroySession(req.adminSessionToken);
  } catch (error) {
    return next(error);
  }
  
  res.clearCookie('adminSession', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict'
  });
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
    const { search, enabled, missing, source, sort, fields, limit = 50, page = 1 } = req.query;
    
    const query = {};
    
    if (search) {
      const safeSearch = escapeRegex(String(search).trim().slice(0, 100));
      query.$or = [
        { id: { $regex: safeSearch, $options: 'i' } },
        { name: { $regex: safeSearch, $options: 'i' } },
        { 'official.name': { $regex: safeSearch, $options: 'i' } },
        { 'randomizer.displayName': { $regex: safeSearch, $options: 'i' } },
        { 'randomizer.shortName': { $regex: safeSearch, $options: 'i' } },
        { 'integrations.racetime.gameSlug': { $regex: safeSearch, $options: 'i' } }
      ];
    }
    
    if (enabled !== undefined && enabled !== '') {
      query.enabled = enabled === 'true' ? { $ne: false } : false;
    }

    const [covers, histories] = await Promise.all([coverIds(), historyIds()]);

    // What a game lacks: its files (history, cover) or an integration
    const missingFilters = {
      history: { id: { $nin: [...histories] } },
      cover: { id: { $nin: [...covers] } },
      racetime: { 'integrations.racetime.enabled': { $ne: true } },
      twitch: { 'integrations.twitch.categoryId': { $in: [null, ''] } },
      'official-site': { 'resources.officialSite.url': { $in: [null, ''] } }
    };
    const sourceFilters = {
      apworld: { 'integrations.apworld.enabled': true },
      archipelago: { 'integrations.archipelago.enabled': true },
      multiworld: { 'integrations.multiworld.enabled': true },
      'rando-list': { 'integrations.randoList.enabled': true },
      racetime: { 'integrations.racetime.enabled': true },
      manual: { 'source.origin': 'manual' }
    };
    const and = [missingFilters[missing], sourceFilters[source]].filter(Boolean);
    if (and.length) query.$and = and;

    const sorts = {
      recent: { createdAt: -1 },
      updated: { updatedAt: -1 },
      id: { id: 1 }
    };
    
    const limitNum = Math.min(5000, Math.max(1, parseInt(limit, 10) || 50));
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    // Light: what the game pickers need, without the resources and categories
    const projection = fields === 'light'
      ? 'id name enabled randomizer.shortName randomizer.displayName resources.officialSite.url resources.sites.url integrations.racetime.gameSlug'
      : null;
    
    const [games, total] = await Promise.all([
      Game.find(query)
        .select(projection)
        .sort(sorts[sort] || { name: 1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      Game.countDocuments(query)
    ]);
    
    res.json({
      games: games.map(game => ({
        ...game,
        hasCover: covers.has(game.id),
        hasHistory: histories.has(game.id)
      })),
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum)
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
    
    const [covers, histories] = await Promise.all([coverIds(), historyIds()]);
    res.json({
      ...game,
      hasCover: covers.has(game.id),
      hasHistory: histories.has(game.id),
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
 * Update the provided fields of a game
 */
router.put('/games/:id', requireAdmin, async (req, res, next) => {
  try {
    const { _id, id, createdAt, updatedAt, ...updateData } = req.body;
    
    // Flattened: saving the form's integrations must not erase the others (Twitch, APWorlds...)
    const game = await Game.findOneAndUpdate(
      { id: req.params.id },
      { $set: flattenObject(updateData) },
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
    
    try {
      await changeGameId(oldId, newId);
      await renameHistory(oldId, newId);
      await renameCover(oldId, newId);
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      throw error;
    }
    
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
    
    let mergedCount;
    try {
      ({ mergedResources: mergedCount } = await mergeGames(targetId, sourceId));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      throw error;
    }
    
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
    const updates = flattenObject(req.body);
    
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

// ==================== COVER ====================

/**
 * PUT /api/admin/games/:id/cover
 * Replace the game's cover (public/assets/<id>.png) with a PNG data URL
 */
router.put('/games/:id/cover', requireAdmin, async (req, res, next) => {
  try {
    if (!await Game.exists({ id: req.params.id })) {
      return res.status(404).json({ error: 'Game not found' });
    }
    res.json({ success: true, ...(await writeCover(req.params.id, req.body?.dataUrl)) });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

/**
 * DELETE /api/admin/games/:id/cover
 */
router.delete('/games/:id/cover', requireAdmin, async (req, res, next) => {
  try {
    res.json({ success: await deleteCover(req.params.id) });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

// ==================== HISTORY ====================

/**
 * GET /api/admin/games/:id/history
 * The game's history file, null when it has none
 */
router.get('/games/:id/history', requireAdmin, async (req, res, next) => {
  try {
    res.json({ history: await readHistory(req.params.id) });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

/**
 * PUT /api/admin/games/:id/history
 * Write the game's history file (public/data/history/<id>.json)
 */
router.put('/games/:id/history', requireAdmin, async (req, res, next) => {
  try {
    if (!await Game.exists({ id: req.params.id })) {
      return res.status(404).json({ error: 'Game not found' });
    }
    res.json({ history: await writeHistory(req.params.id, req.body) });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

/**
 * DELETE /api/admin/games/:id/history
 * Remove the game's history file (its History tab disappears)
 */
router.delete('/games/:id/history', requireAdmin, async (req, res, next) => {
  try {
    res.json({ success: await deleteHistory(req.params.id) });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
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
      .select('resources integrations.randoList')
      .lean();
    
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }
    
    res.json({
      resources: game.resources || {},
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
    const enabled = { enabled: { $ne: false } };
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [covers, histories] = await Promise.all([coverIds(), historyIds()]);
    const [
      totalGames,
      enabledGames,
      totalRaces,
      racesThisWeek,
      totalTournaments,
      totalPlayers,
      gamesNeedingResources,
      gamesWithMultipleSites,
      gamesWithoutHistory,
      gamesWithoutCover,
      recentGames,
      openTournaments,
      jobs
    ] = await Promise.all([
      Game.countDocuments(),
      Game.countDocuments(enabled),
      Race.estimatedDocumentCount(),
      Race.countDocuments({ startedAt: { $gte: weekAgo } }),
      Tournament.estimatedDocumentCount(),
      // The players the site lists: racetime accounts that still exist
      Player.countDocuments({ userId: { $ne: null }, racetimeDeletedAt: null }),
      Game.countDocuments({ ...enabled, 'resources.officialSite.url': { $in: [null, ''] } }),
      // Several sites, none chosen as the official one
      Game.countDocuments({ ...enabled, 'resources.sites.1': { $exists: true }, 'resources.officialSite.url': { $in: [null, ''] } }),
      Game.countDocuments({ ...enabled, id: { $nin: [...histories] } }),
      Game.countDocuments({ ...enabled, id: { $nin: [...covers] } }),
      Game.find({ createdAt: { $gte: weekAgo } })
        .select('id name randomizer.shortName randomizer.displayName source.origin createdAt')
        .sort({ createdAt: -1 })
        .limit(15)
        .lean(),
      Tournament.find({ $or: [{ endDate: null }, { endDate: { $gte: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) } }] })
        .select('name startDate endDate lastActivityAt state status midosHouse.schedule.startAt')
        .lean(),
      getJobsHealth({ Game, Tournament, Race })
    ]);

    res.json({
      games: {
        total: totalGames,
        enabled: enabledGames,
        needingResources: gamesNeedingResources,
        needingOfficialSite: gamesWithMultipleSites,
        withoutHistory: gamesWithoutHistory,
        withoutCover: gamesWithoutCover,
        recent: recentGames.map(g => ({
          id: g.id,
          name: g.randomizer?.displayName || g.randomizer?.shortName || g.name,
          origin: g.source?.origin || 'manual',
          createdAt: g.createdAt
        }))
      },
      races: totalRaces,
      racesThisWeek,
      tournaments: totalTournaments,
      tournamentsOngoing: openTournaments.filter(t => calculateTournamentStatus(t) === 'en cours').length,
      players: totalPlayers,
      failingJobs: jobs.filter(job => job.state === 'error' || job.state === 'late').map(job => ({ name: job.name, label: job.label, state: job.state }))
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/content-stats
 * The catalog and the data the site holds, for the Statistics tab
 */
router.get('/content-stats', requireAdmin, async (req, res, next) => {
  try {
    const enabled = { enabled: { $ne: false } };
    const yearAgo = new Date();
    yearAgo.setUTCMonth(yearAgo.getUTCMonth() - 11, 1);
    yearAgo.setUTCHours(0, 0, 0, 0);
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [covers, histories] = await Promise.all([coverIds(), historyIds()]);
    const count = (filter) => Game.countDocuments({ ...enabled, ...filter });

    const [
      gamesEnabled, withHistory, withCover, withRacetime, withTwitch, withOfficialSite,
      onRandoList, onArchipelago, onMultiworld, onApworld, withCategories,
      racesByMonth, topCategories, tournamentsByYear, playersActive, playersTotal, playersWithTwitch
    ] = await Promise.all([
      count({}),
      count({ id: { $in: [...histories] } }),
      count({ id: { $in: [...covers] } }),
      count({ 'integrations.racetime.enabled': true }),
      count({ 'integrations.twitch.categoryId': { $nin: [null, ''] } }),
      count({ 'resources.officialSite.url': { $nin: [null, ''] } }),
      count({ 'integrations.randoList.enabled': true }),
      count({ 'integrations.archipelago.enabled': true }),
      count({ 'integrations.multiworld.enabled': true }),
      count({ 'integrations.apworld.enabled': true }),
      count({ 'categories.0': { $exists: true } }),
      Race.aggregate([
        { $match: { startedAt: { $gte: yearAgo } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$startedAt' } }, races: { $sum: 1 } } },
        { $sort: { _id: 1 } }
      ]),
      Race.aggregate([
        { $match: { startedAt: { $gte: monthAgo } } },
        { $group: { _id: '$category', races: { $sum: 1 } } },
        { $sort: { races: -1 } },
        { $limit: 10 }
      ]),
      Tournament.aggregate([
        { $match: { startDate: { $ne: null } } },
        { $group: { _id: { $year: '$startDate' }, tournaments: { $sum: 1 } } },
        { $sort: { _id: 1 } }
      ]),
      Race.distinct('entrants.userId', { startedAt: { $gte: monthAgo } }).then(ids => ids.filter(Boolean).length),
      Player.countDocuments({ userId: { $ne: null }, racetimeDeletedAt: null }),
      Player.countDocuments({ userId: { $ne: null }, racetimeDeletedAt: null, twitch: { $nin: [null, ''] } })
    ]);

    // Racetime categories under the name of their game
    const slugs = topCategories.map(c => c._id);
    const games = await Game.find({ $or: [{ 'integrations.racetime.gameSlug': { $in: slugs } }, { 'integrations.racetime.gameSlugs': { $in: slugs } }] })
      .select('id name randomizer.shortName randomizer.displayName integrations.racetime.gameSlug integrations.racetime.gameSlugs')
      .lean();
    const gameOfSlug = new Map();
    games.forEach(g => [g.integrations?.racetime?.gameSlug, ...(g.integrations?.racetime?.gameSlugs || [])]
      .filter(Boolean).forEach(slug => gameOfSlug.set(slug, g)));

    res.json({
      catalog: {
        games: gamesEnabled, withHistory, withCover, withRacetime, withTwitch, withOfficialSite,
        onRandoList, onArchipelago, onMultiworld, onApworld, withCategories
      },
      racesByMonth: racesByMonth.map(m => ({ month: m._id, races: m.races })),
      topCategories: topCategories.map(c => {
        const game = gameOfSlug.get(c._id);
        return {
          slug: c._id,
          gameId: game?.id || null,
          name: game ? (game.randomizer?.displayName || game.randomizer?.shortName || game.name) : c._id,
          races: c.races
        };
      }),
      tournamentsByYear: tournamentsByYear.map(y => ({ year: y._id, tournaments: y.tournaments })),
      players: { total: playersTotal, activeLast30Days: playersActive, withTwitch: playersWithTwitch }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/jobs
 * The server's scheduled tasks and the state of their last run
 */
router.get('/jobs', requireAdmin, async (req, res, next) => {
  try {
    res.json({ jobs: await getJobsHealth({ Game, Tournament, Race }) });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/jobs/:name/log
 * The log of the task's last run
 */
router.get('/jobs/:name/log', requireAdmin, (req, res) => {
  if (!JOBS.some(job => job.name === req.params.name)) {
    return res.status(404).json({ error: 'Unknown task' });
  }
  res.json({ lines: readJobLog(req.params.name) });
});

/**
 * POST /api/admin/jobs/:name/run
 * Start a scheduled task now, through the same script as the crontab: same logs,
 * same status file, and its lock skips the run if the task is already running
 */
router.post('/jobs/:name/run', requireAdmin, (req, res, next) => {
  try {
    if (!JOBS.some(job => job.name === req.params.name)) {
      return res.status(404).json({ error: 'Unknown task' });
    }
    const { spawn } = require('child_process');
    const path = require('path');
    // The crontab has no TMPDIR: the lock must be the same file as its runs'
    const env = { ...process.env };
    delete env.TMPDIR;
    const child = spawn(path.join(__dirname, '..', 'scripts', 'cron', 'run-job.sh'), [req.params.name], {
      detached: true,
      stdio: 'ignore',
      env
    });
    child.on('error', error => console.error(`Task ${req.params.name}: ${error.message}`));
    child.unref();
    res.json({ success: true, pid: child.pid });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/sync/racetime/:gameId
 * Trigger racetime sync for a specific game, or for every game with gameId "all"
 */
router.post('/sync/racetime/:gameId', requireAdmin, async (req, res, next) => {
  try {
    const { spawn } = require('child_process');
    const path = require('path');

    const syncAll = req.params.gameId === 'all';
    const scriptPath = path.join(__dirname, '..', 'scripts', syncAll ? 'sync-racetime-global.js' : 'sync-racetime-game.js');
    const args = syncAll ? [] : ['--game', req.params.gameId];

    if (!syncAll && req.body.maxPages) {
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
 * Players of the site (racetime accounts), with the counts kept by the players sync
 */
router.get('/players', requireAdmin, async (req, res, next) => {
  try {
    const { search, filter, sort, limit = 50, page = 1 } = req.query;
    const base = { userId: { $ne: null } };
    const query = { ...base };

    if (search) {
      const safeSearch = escapeRegex(String(search).trim().slice(0, 100));
      query.$or = ['name', 'userId', 'twitch', 'aliases'].map(field => ({ [field]: { $regex: safeSearch, $options: 'i' } }));
    }

    const filters = {
      twitch: { twitch: { $nin: [null, ''] } },
      'no-twitch': { twitch: { $in: [null, ''] } },
      aliases: { 'aliases.0': { $exists: true } },
      deleted: { racetimeDeletedAt: { $ne: null } }
    };
    // Accounts deleted from racetime leave the site's lists: only shown when asked for
    Object.assign(query, filters[filter] || { racetimeDeletedAt: null });

    const sorts = {
      races: { 'stats.totalRaces': -1, name: 1 },
      wins: { 'stats.totalWins': -1, name: 1 },
      recent: { createdAt: -1 }
    };
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

    const [players, total, active, withTwitch, withAliases, deleted] = await Promise.all([
      Player.find(query)
        .select('userId name racetimeUrl twitch aliases racetimeDeletedAt stats.totalRaces stats.totalWins createdAt')
        .sort(sorts[sort] || { name: 1 })
        .collation({ locale: 'fr', strength: 1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      Player.countDocuments(query),
      Player.countDocuments({ ...base, racetimeDeletedAt: null }),
      Player.countDocuments({ ...base, racetimeDeletedAt: null, ...filters.twitch }),
      Player.countDocuments({ ...base, racetimeDeletedAt: null, ...filters.aliases }),
      Player.countDocuments({ ...base, ...filters.deleted })
    ]);

    res.json({
      players,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum)
      },
      stats: { total: active, withTwitch, withAliases, deleted }
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
    // The name and the racetime profile come from racetime.gg: the syncs keep them up to date
    const { twitch } = req.body;
    const update = { twitch: String(twitch || '').trim() || null };

    if (req.body.aliases !== undefined) {
      if (!Array.isArray(req.body.aliases)) {
        return res.status(400).json({ error: 'aliases must be an array' });
      }

      const current = await Player.findOne({ userId: req.params.id }).select('name').lean();
      if (!current) {
        return res.status(404).json({ error: 'Player not found' });
      }

      const ownKey = normalizePlayerName(current.name);
      const seen = new Set([ownKey]);
      const aliases = [];
      for (const raw of req.body.aliases) {
        const alias = String(raw || '').trim().slice(0, 100);
        const key = normalizePlayerName(alias);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        aliases.push(alias);
      }
      if (aliases.length > 20) {
        return res.status(400).json({ error: 'Too many aliases (max 20)' });
      }

      // An alias must not already be another player's name or alias
      const others = await Player.find({ userId: { $ne: req.params.id } }).select('name aliases').lean();
      const taken = new Map();
      others.forEach(o => {
        taken.set(normalizePlayerName(o.name), o.name);
        (o.aliases || []).forEach(a => taken.set(normalizePlayerName(a), o.name));
      });
      const conflict = aliases.find(a => taken.has(normalizePlayerName(a)));
      if (conflict) {
        return res.status(409).json({
          error: `Alias "${conflict}" is already used by ${taken.get(normalizePlayerName(conflict))}`
        });
      }

      update.aliases = aliases;
    }

    // Players use userId (racetime ID) as primary identifier
    const player = await Player.findOneAndUpdate(
      { userId: req.params.id },
      { $set: update },
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
    
    // System info
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    // Disk holding the app, its logs and the backups
    let disk = null;
    try {
      const stats = await require('fs').promises.statfs(__dirname);
      disk = {
        total: formatBytes(stats.blocks * stats.bsize),
        free: formatBytes(stats.bavail * stats.bsize),
        usedPercent: Math.round(100 * (1 - stats.bavail / stats.blocks))
      };
    } catch {
      // statfs is missing on some platforms
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
    
    const jobs = await getJobsHealth({ Game, Tournament, Race });

    res.json({
      api: { status: 'ok', description: 'API du site Randomizer' },
      database: { status: dbStatus },
      racetime: { status: racetimeStatus },
      twitch: { status: twitchStatus },
      challonge: { status: challongeStatus },
      startgg: { status: startggStatus },
      system: {
        now: new Date(),
        uptime: process.uptime(),
        hostUptime: os.uptime(),
        nodeVersion: process.version,
        load: os.loadavg().map((value) => Math.round(value * 100) / 100),
        cpus: os.cpus().length,
        memory: {
          total: formatBytes(totalMem),
          used: formatBytes(usedMem),
          usedPercent: Math.round(100 * usedMem / totalMem),
          app: formatBytes(process.memoryUsage().rss)
        },
        disk
      },
      // PM2 runs the app in production and passes its process state in the environment
      pm2: process.env.pm_id !== undefined ? {
        name: process.env.name || null,
        restarts: Number(process.env.restart_time) || 0,
        unstableRestarts: Number(process.env.unstable_restarts) || 0,
        memoryLimit: Number(process.env.max_memory_restart) ? formatBytes(Number(process.env.max_memory_restart)) : null
      } : null,
      jobs
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
const {
  loadNormalizedMatches,
  loadCandidateRaces,
  buildAutoLinkPreview,
  applyAutoLinkProposals,
  QUALIFIER_PHASE
} = require('../services/tournament-autolink');
const {
  buildQualifierPreview,
  applyQualifiers,
  importRacetimeRace
} = require('../services/tournament-qualifiers');

/**
 * Parse a racetime URL to extract category and raceId.
 * Accepts: https://racetime.gg/category/room-name-1234, /category/room-name-1234, category/room-name-1234
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
    const { search, coverage: coverageFilter, sort } = req.query;
    const limit = Math.max(1, parseInt(req.query.limit) || 30);
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const query = {};

    if (search) {
      const safeSearch = escapeRegex(String(search).trim().slice(0, 100));
      query.$or = [
        { name: { $regex: safeSearch, $options: 'i' } },
        { gameName: { $regex: safeSearch, $options: 'i' } }
      ];
    }

    // Coverage is computed on every tournament of the search, to filter and sort on it
    const tournaments = await Tournament.find(query)
      .populate('game', 'id name')
      .sort({ startDate: -1 })
      .select('name gameName gameId startDate endDate startggId challongeId participantsCount game matches.state matches.displayScore matches.withdrawnEntrantId matches.raceUrl matches.raceUrls matches.startggSetId matches.player1.name matches.player2.name')
      .lean();

    const [coverage, challongeCounts] = await Promise.all([
      computeLinkCoverage({ tournaments, Match, Race }),
      Match.aggregate([
        { $match: { tournamentId: { $in: tournaments.filter(t => !!t.challongeId).map(t => t._id) } } },
        { $group: { _id: '$tournamentId', count: { $sum: 1 } } }
      ])
    ]);

    const challongeCountMap = new Map(
      challongeCounts.map(entry => [String(entry._id), entry.count])
    );

    let results = tournaments.map(t => ({
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
        : (challongeCountMap.get(String(t._id)) || 0),
      coverage: coverage.get(String(t._id))
    }));

    // "todo": played matches without races, or races attached to no match
    if (coverageFilter === 'todo') {
      results = results.filter(t => t.coverage.status === 'partial' || t.coverage.orphanRaces > 0);
    } else if (['partial', 'complete', 'none'].includes(coverageFilter)) {
      results = results.filter(t => t.coverage.status === coverageFilter);
    }
    if (sort === 'missing') {
      results.sort((a, b) => (b.coverage.missingMatches + b.coverage.orphanRaces) - (a.coverage.missingMatches + a.coverage.orphanRaces));
    }

    const total = results.length;
    res.json({
      tournaments: results.slice((page - 1) * limit, page * limit),
      coverageSummary: summarizeCoverage(coverage),
      pagination: { total, page, limit, pages: Math.ceil(total / limit) }
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
      const isAttached = !!r.tournamentId && String(r.tournamentId) === tournamentIdStr;
      const isLinked = !!(r.matchId || r.startggSetId);
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
        // Qualifiers of this tournament: attached without a match
        isQualifier: isAttached && !isLinked && (r.tournamentPhase === QUALIFIER_PHASE || stageInfo.type === 'qualifier'),
        isLinked,
        isAttached
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
          player2Name: embedded.player2?.name,
          player1Members: embedded.player1?.members || [],
          player2Members: embedded.player2?.members || []
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
        race = await importRacetimeRace({ raceUrl: parsed.normalizedUrl, Race, Player });
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
      race.tournamentPhase = QUALIFIER_PHASE;
      race.tournamentPool = undefined;
      race.tournamentRound = undefined;
      await race.save();
      return res.json({ success: true, message: 'Race linked as qualifier' });
    }

    if (!matchId) return res.status(400).json({ error: 'matchId is required for non-qualifier linking' });
    // A qualifier linked to a match is no longer a qualifier
    if (race.tournamentPhase === QUALIFIER_PHASE) race.tournamentPhase = undefined;

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
    await syncParticipantAccounts({ tournament, Race });

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
    // A qualifier has no match: removing it detaches it from the tournament
    const wasQualifier = !(race.matchId || race.startggSetId) && String(race.tournamentId) === String(tournament._id);

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
    race.tiebreak = undefined;
    if (wasQualifier) race.tournamentId = undefined;
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
 * GET /api/admin/tournaments/:id/qualifiers-preview?racetime=1
 * Qualifier rooms the tournament can take; with racetime=1 also looks on racetime.gg
 * for the ones missing from the database (takes about a minute)
 */
router.get('/tournaments/:id/qualifiers-preview', requireAdmin, async (req, res, next) => {
  try {
    const tournament = await Tournament.findById(req.params.id)
      .populate('game')
      .lean();
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    const preview = await buildQualifierPreview({
      tournament,
      Race,
      racetime: req.query.racetime === '1'
    });
    res.json(preview);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/tournaments/:id/qualifiers-confirm
 * Attach the selected rooms as qualifiers, importing the missing ones from racetime.gg
 */
router.post('/tournaments/:id/qualifiers-confirm', requireAdmin, async (req, res, next) => {
  try {
    const { raceUrls } = req.body;
    if (!Array.isArray(raceUrls) || !raceUrls.length || !raceUrls.every((url) => typeof url === 'string')) {
      return res.status(400).json({ error: 'raceUrls array is required' });
    }

    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    const result = await applyQualifiers({ tournament, raceUrls, Race, Player });
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

// ==================== TOURNAMENT MANAGEMENT ====================

const StartGGAPI = require('../services/startgg');
const challongeService = require('../services/challonge');
const sanitizeHtml = require('sanitize-html');

/**
 * Parse a start.gg URL to extract the tournament slug.
 * Accepts various formats:
 *   https://start.gg/tournament/my-tournament
 *   https://www.start.gg/tournament/my-tournament/event/bracket
 *   https://smash.gg/tournament/my-tournament/...
 */
function parseStartggSlug(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    if (host !== 'start.gg' && host !== 'smash.gg') return null;
    const match = parsed.pathname.match(/^\/(tournament\/[^/]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Parse a Challonge URL to extract the tournament identifier.
 * Accepts:
 *   https://challonge.com/my-tournament
 *   https://challonge.com/fr/my-tournament
 *   https://challonge.com/tournaments/12345
 *   https://community.challonge.com/my-tournament
 */
function parseChallongeId(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    if (!host.endsWith('challonge.com')) return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    // Skip language codes like 'fr', 'en', etc.
    const filtered = parts.filter(p => !/^[a-z]{2}$/.test(p) && p !== 'tournaments');
    return filtered.length ? filtered[filtered.length - 1] : null;
  } catch {
    return null;
  }
}

/**
 * Detect source from URL string
 */
function detectTournamentSource(url) {
  const startggSlug = parseStartggSlug(url);
  if (startggSlug) return { source: 'startgg', slug: startggSlug };
  const challongeId = parseChallongeId(url);
  if (challongeId) return { source: 'challonge', id: challongeId };
  return null;
}

function cleanHtml(description) {
  if (!description) return null;
  return sanitizeHtml(description, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'br']),
    allowedAttributes: {
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height']
    },
    allowedSchemesByTag: {
      a: ['http', 'https', 'mailto'],
      img: ['http', 'https', 'data']
    }
  });
}

/**
 * GET /api/admin/tournaments-mgmt
 * List tournaments with pagination, search and filters
 */
router.get('/tournaments-mgmt', requireAdmin, async (req, res, next) => {
  try {
    const { search, source, game, status, sort, limit = 20, page = 1 } = req.query;
    const query = {};

    if (search) {
      const safeSearch = escapeRegex(String(search).trim().slice(0, 100));
      query.$or = [
        { name: { $regex: safeSearch, $options: 'i' } },
        { gameSlug: { $regex: safeSearch, $options: 'i' } },
        { gameName: { $regex: safeSearch, $options: 'i' } },
        { startggSlug: { $regex: safeSearch, $options: 'i' } },
        { url: { $regex: safeSearch, $options: 'i' } }
      ];
    }

    if (source === 'startgg') {
      query.startggId = { $exists: true, $ne: null };
    } else if (source === 'challonge') {
      query.challongeId = { $exists: true, $ne: null };
    } else if (source === 'other') {
      query.startggId = null;
      query.challongeId = null;
    }

    if (game) {
      query.gameSlug = game;
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const order = sort === 'imported' ? { createdAt: -1 } : { startDate: -1, createdAt: -1 };

    // The status is computed from the dates: filtered on the ids, then paginated
    if (['à venir', 'en cours', 'terminé'].includes(status)) {
      const candidates = await Tournament.find(query)
        .select('startDate endDate lastActivityAt state status midosHouse.schedule.startAt')
        .sort(order)
        .lean();
      query._id = { $in: candidates.filter(t => calculateTournamentStatus(t) === status).map(t => t._id) };
    }

    const [tournaments, total] = await Promise.all([
      Tournament.find(query)
        .select('-participants -challongeBrackets -alttprAsyncs -midosHouse.pastRestreams -midosHouse.pastStarts')
        .sort(order)
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .populate('game', 'id name randomizer.shortName randomizer.displayName')
        .lean(),
      Tournament.countDocuments(query)
    ]);

    // Where the bracket comes from: start.gg, Challonge, else the site of its page (leagues)
    const sourceOf = (t) => {
      if (t.startggId) return { source: 'startgg', sourceLabel: 'start.gg' };
      if (t.challongeId) return { source: 'challonge', sourceLabel: 'Challonge' };
      try {
        return { source: 'other', sourceLabel: new URL(t.fullUrl || t.url || t.midosHouse?.url).hostname.replace(/^www\./, '') };
      } catch {
        return { source: 'other', sourceLabel: 'autre' };
      }
    };

    const results = tournaments.map(t => ({
      _id: t._id,
      name: t.name,
      ...sourceOf(t),
      gameSlug: t.gameSlug,
      gameName: t.gameName || t.game?.name,
      gameShortName: t.game?.randomizer?.shortName,
      participantsCount: t.participantsCount || (t.participants || []).length,
      matchCount: (t.matches || []).length || 0,
      state: t.state,
      status: calculateTournamentStatus(t),
      scheduleSite: t.midosHouse?.url ? (t.midosHouse.site === 'hth' ? 'Hyrule Town Hall' : "Mido's House") : null,
      startDate: t.startDate,
      endDate: t.endDate,
      startggSlug: t.startggSlug,
      challongeId: t.challongeId,
      url: t.fullUrl || t.url,
      createdAt: t.createdAt
    }));

    res.json({ tournaments: results, total, page: pageNum, totalPages: Math.ceil(total / limitNum) });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/tournaments-mgmt/games-list
 * Get list of games for tournament association dropdown
 */
router.get('/tournaments-mgmt/games-list', requireAdmin, async (req, res, next) => {
  try {
    const games = await Game.find({ enabled: true })
      .select('id name randomizer.shortName')
      .sort({ name: 1 })
      .lean();
    res.json(games);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/tournaments-mgmt/:id
 * Get tournament detail
 */
router.get('/tournaments-mgmt/:id', requireAdmin, async (req, res, next) => {
  try {
    const tournament = await Tournament.findById(req.params.id).populate('game', 'id name randomizer.shortName').lean();
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    // Count linked races
    const linkedRaces = await Race.countDocuments({ tournamentId: tournament._id });
    // For challonge, also count Match docs
    let matchCount = (tournament.matches || []).length;
    if (tournament.challongeId) {
      matchCount = await Match.countDocuments({ tournamentId: tournament._id });
    }

    const source = tournament.startggId ? 'startgg' : tournament.challongeId ? 'challonge' : 'unknown';

    res.json({
      ...tournament,
      source,
      linkedRaces,
      matchCountTotal: matchCount
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/tournaments-mgmt/preview
 * Preview (fetch without saving) a tournament from its URL
 */
router.post('/tournaments-mgmt/preview', requireAdmin, async (req, res, next) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL requise' });

    const detected = detectTournamentSource(url);
    if (!detected) return res.status(400).json({ error: 'URL non reconnue. Utilisez une URL start.gg ou challonge.com.' });

    if (detected.source === 'startgg') {
      const api = new StartGGAPI();
      const tournamentData = await api.getTournament(detected.slug);
      if (!tournamentData) return res.status(404).json({ error: 'Tournoi start.gg introuvable' });

      // Check if already imported
      const existing = await Tournament.findOne({ startggSlug: detected.slug }).lean();

      return res.json({
        source: 'startgg',
        alreadyImported: !!existing,
        existingId: existing?._id,
        preview: {
          name: tournamentData.name,
          slug: tournamentData.slug,
          startDate: tournamentData.startDate,
          endDate: tournamentData.endDate,
          numAttendees: tournamentData.numAttendees,
          events: tournamentData.events?.map(e => ({
            name: e.name,
            numEntrants: e.numEntrants,
            setsTotal: e.setsTotal,
            game: e.game
          })) || []
        }
      });
    }

    if (detected.source === 'challonge') {
      const tournamentData = await challongeService.getTournament(detected.id);
      if (!tournamentData) return res.status(404).json({ error: 'Tournoi Challonge introuvable' });

      const existing = await Tournament.findOne({ challongeId: tournamentData.id }).lean();

      return res.json({
        source: 'challonge',
        alreadyImported: !!existing,
        existingId: existing?._id,
        preview: {
          name: tournamentData.name,
          challongeId: tournamentData.id,
          url: tournamentData.fullUrl || tournamentData.url,
          state: tournamentData.state,
          participantsCount: tournamentData.participantsCount,
          tournamentType: tournamentData.tournamentType,
          gameName: tournamentData.gameName
        }
      });
    }
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/tournaments-mgmt/import
 * Import a tournament from start.gg or challonge.com and associate to a game
 */
router.post('/tournaments-mgmt/import', requireAdmin, async (req, res, next) => {
  try {
    const { url, gameSlug } = req.body;
    if (!url) return res.status(400).json({ error: 'URL requise' });
    if (!gameSlug) return res.status(400).json({ error: 'Jeu requis' });

    const game = await Game.findOne({ id: gameSlug });
    if (!game) return res.status(404).json({ error: `Jeu "${gameSlug}" introuvable` });

    const detected = detectTournamentSource(url);
    if (!detected) return res.status(400).json({ error: 'URL non reconnue' });

    if (detected.source === 'startgg') {
      const api = new StartGGAPI();
      const tournamentData = await api.getTournament(detected.slug);
      if (!tournamentData) return res.status(404).json({ error: 'Tournoi start.gg introuvable' });

      // Pick the first event (or the one matching the game) for sets/participants
      const event = tournamentData.events?.[0];

      const tournamentPayload = {
        name: tournamentData.name,
        startggId: tournamentData.id,
        startggSlug: tournamentData.slug,
        startDate: tournamentData.startDate,
        endDate: tournamentData.endDate,
        participantsCount: tournamentData.numAttendees,
        game: game._id,
        gameSlug: game.id,
        gameName: game.name,
        source: { type: 'startgg', externalId: String(tournamentData.id), url: tournamentData.sourceUrl, importedAt: new Date() }
      };

      if (event) {
        tournamentPayload.setsTotal = event.setsTotal;
        tournamentPayload.phases = event.phases?.map(p => ({
          startggPhaseId: String(p.id),
          name: p.name,
          bracketType: p.bracketType,
          phaseOrder: p.phaseOrder,
          numSeeds: p.numSeeds,
          groupCount: p.groupCount,
          state: p.state
        })) || [];
        tournamentPayload.matches = event.sets?.map(s => ({
          startggSetId: String(s.id),
          round: s.round,
          displayScore: s.displayScore,
          completedAt: s.completedAt,
          state: s.state,
          phase: s.phase?.name,
          phaseGroup: s.phaseGroup?.displayIdentifier,
          player1: { ...StartGGAPI.setPlayer(s.entrants?.[0]), startggEntrantId: String(s.entrants?.[0]?.id || ''), name: s.entrants?.[0]?.name || '' },
          player2: { ...StartGGAPI.setPlayer(s.entrants?.[1]), startggEntrantId: String(s.entrants?.[1]?.id || ''), name: s.entrants?.[1]?.name || '' },
          winnerId: s.winnerId
        })) || [];
        tournamentPayload.participants = StartGGAPI.buildParticipants(event);
      }

      const tournament = await Tournament.findOneAndUpdate(
        { startggSlug: detected.slug },
        { $set: tournamentPayload },
        { upsert: true, new: true }
      );

      return res.json({ success: true, tournament: { _id: tournament._id, name: tournament.name }, created: !tournament.isNew });
    }

    if (detected.source === 'challonge') {
      const details = await challongeService.getTournamentDetails(detected.id);
      const { tournamentData, matches } = details;
      if (!tournamentData) return res.status(404).json({ error: 'Tournoi Challonge introuvable' });

      // Ranks of the played bracket while the organizer has not finalized it
      const participants = fillMissingFinalRanks({ tournamentData, participants: details.participants, matches });

      const tournamentPayload = {
        name: tournamentData.name,
        challongeId: tournamentData.id,
        url: tournamentData.url,
        fullUrl: tournamentData.fullUrl,
        tournamentType: tournamentData.tournamentType,
        state: tournamentData.state,
        participantsCount: tournamentData.participantsCount,
        description: cleanHtml(tournamentData.description),
        participants,
        startDate: tournamentData.startedAt,
        endDate: tournamentData.completedAt,
        gameName: tournamentData.gameName,
        game: game._id,
        gameSlug: game.id,
        source: { type: 'challonge', externalId: String(tournamentData.id), url: tournamentData.fullUrl, importedAt: new Date() }
      };

      const tournament = await Tournament.findOneAndUpdate(
        { challongeId: tournamentData.id },
        { $set: tournamentPayload },
        { upsert: true, new: true }
      );

      // Upsert matches
      const participantMap = new Map();
      participants.forEach(p => {
        participantMap.set(p.challongeId, p);
        if (p.groupPlayerIds && Array.isArray(p.groupPlayerIds)) {
          p.groupPlayerIds.forEach(gid => participantMap.set(gid, p));
        }
      });

      for (const m of matches) {
        const player1 = participantMap.get(m.player1Id);
        const player2 = participantMap.get(m.player2Id);
        await Match.findOneAndUpdate(
          { challongeId: m.id },
          { $set: {
            ...m,
            tournamentId: tournament._id,
            tournamentChallongeId: tournament.challongeId,
            player1Name: player1 ? (player1.displayName || player1.name) : null,
            player2Name: player2 ? (player2.displayName || player2.name) : null
          } },
          { upsert: true }
        );
      }

      return res.json({ success: true, tournament: { _id: tournament._id, name: tournament.name }, matchesImported: matches.length });
    }
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/admin/tournaments-mgmt/:id/game
 * Update the game association for a tournament
 */
router.put('/tournaments-mgmt/:id/game', requireAdmin, async (req, res, next) => {
  try {
    const { gameSlug } = req.body;
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    if (gameSlug) {
      const game = await Game.findOne({ id: gameSlug });
      if (!game) return res.status(404).json({ error: `Jeu "${gameSlug}" introuvable` });
      tournament.game = game._id;
      tournament.gameSlug = game.id;
      tournament.gameName = game.name;
    } else {
      tournament.game = null;
      tournament.gameSlug = null;
    }

    await tournament.save();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/admin/tournaments-mgmt/:id
 * Delete a tournament and its linked data
 */
router.delete('/tournaments-mgmt/:id', requireAdmin, async (req, res, next) => {
  try {
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    // Unlink races that were associated to this tournament
    await Race.updateMany(
      { tournamentId: tournament._id },
      { $unset: { tournamentId: 1, matchId: 1, startggSetId: 1, matchPlayers: 1, matchConfidence: 1, tournamentPhase: 1, tournamentPool: 1, tournamentRound: 1, tiebreak: 1 } }
    );

    // Delete challonge matches if any
    if (tournament.challongeId) {
      await Match.deleteMany({ tournamentId: tournament._id });
    }

    await Tournament.deleteOne({ _id: tournament._id });

    res.json({ success: true, name: tournament.name });
  } catch (err) {
    next(err);
  }
});

// ==================== ANALYTICS (placeholder) ====================

module.exports = router;
