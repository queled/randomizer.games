const express = require('express');
const router = express.Router();
const { Race } = require('../models');
const { validateObjectId } = require('../middleware/security');

// Game ID aliases (maps game IDs to their racetime category slugs)
const CATEGORY_ALIASES = {
  'oot': ['oot', 'ootr'],
  'alttp': ['alttp', 'alttpr'],
  'mm': ['mm', 'mmr'],
  'sm': ['sm', 'smr'],
  'sm64': ['sm64'],
  'dk64': ['dk64','dk64r'],
  'tww': ['tww'],
  'tp': ['tp'],
  'kh2fm': ['kh2fm', 'kh2r', 'kh2fmr'],
  'sotn': ['sotn'],
  'smz3': ['smz3'],
  'ootmm': ['ootmm']
};

// Get all races
router.get('/', async (req, res, next) => {
  try {
    const { category, tournamentId, limit = 50, page = 1 } = req.query;
    
    const query = {};
    
    // Handle category with aliases
    if (category) {
      const aliases = CATEGORY_ALIASES[category.toLowerCase()];
      if (aliases && aliases.length > 1) {
        // Use $in to match any of the aliases
        query.category = { $in: aliases };
      } else if (aliases) {
        query.category = aliases[0];
      } else {
        // Try direct match or regex for partial matches
        query.category = { $regex: new RegExp('^' + category, 'i') };
      }
    }
    
    if (tournamentId) query.tournamentId = tournamentId;

    const races = await Race.find(query)
      .sort({ startedAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));

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
