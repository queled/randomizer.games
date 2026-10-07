const express = require('express');
const router = express.Router();
const { Race, Game } = require('../models');
const { validateObjectId } = require('../middleware/security');
const {
  escapeRegex,
  buildCategoryResolutionContext,
  buildCategoryQuery
} = require('../helpers/game-matching');

// Get all races
router.get('/', async (req, res, next) => {
  try {
    const { category, tournamentId, limit = 50, page = 1 } = req.query;
    
    const query = {};
    
    // A game id resolves to all of its racetime categories, using the same rules as the game pages
    if (category) {
      const categoryLower = String(category).toLowerCase().trim();
      const games = await Game.find().select('id integrations.racetime').lean();
      const gameDoc = games.find(g => String(g.id || '').toLowerCase() === categoryLower);
      if (gameDoc) {
        Object.assign(query, buildCategoryQuery(gameDoc, categoryLower, buildCategoryResolutionContext(games)));
      } else {
        // Direct, case-insensitive exact match only (no prefix match)
        query.category = { $regex: new RegExp(`^${escapeRegex(category)}$`, 'i') };
      }
    }
    
    if (tournamentId) query.tournamentId = tournamentId;

    // Use aggregation to prioritize ongoing/open races
    const races = await Race.aggregate([
      { $match: query },
      {
        $addFields: {
          // Add a priority field: 0 for ongoing/open, 1 for others
          priority: {
            $cond: {
              if: { $in: ['$status', ['in_progress', 'open']] },
              then: 0,
              else: 1
            }
          }
        }
      },
      { $sort: { priority: 1, startedAt: -1 } },
      { $skip: (parseInt(page) - 1) * parseInt(limit) },
      { $limit: parseInt(limit) },
      { $project: { priority: 0 } } // Remove the priority field from output
    ]);

    const total = await Race.countDocuments(query);

    res.json({
      races,
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

// Get race by ID
router.get('/:id', validateObjectId('id'), async (req, res, next) => {
  try {
    const race = await Race.findById(req.params.id);
    
    if (!race) {
      return res.status(404).json({ error: 'Race not found' });
    }

    res.json(race);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
