const express = require('express');
const router = express.Router();
const { Tournament } = require('../models');
const { validateObjectId } = require('../middleware/security');

// Game name patterns for tournament search (same as games.js)
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

// Get all tournaments
router.get('/', async (req, res, next) => {
  try {
    const { gameId, status, limit = 50, page = 1 } = req.query;
    
    const query = {};
    
    // Filter by game using gameName pattern instead of gameId
    if (gameId) {
      const gamePattern = GAME_NAME_PATTERNS[gameId.toLowerCase()];
      if (gamePattern) {
        query.gameName = { $regex: gamePattern };
      }
    }
    
    const tournaments = await Tournament.find(query)
      .sort({ startDate: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));

    const total = await Tournament.countDocuments(query);

    // Calculate status dynamically
    const tournamentsWithStatus = tournaments.map(t => {
      const tournament = t.toObject();
      tournament.status = calculateStatus(tournament);
      return tournament;
    });

    // Filter by status if requested
    let filtered = tournamentsWithStatus;
    if (status) {
      filtered = tournamentsWithStatus.filter(t => t.status === status);
    }

    res.json({
      tournaments: filtered,
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

// Get tournament by ID
router.get('/:id', validateObjectId('id'), async (req, res, next) => {
  try {
    const tournament = await Tournament.findById(req.params.id).populate('game');
    
    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }

    const tournamentObj = tournament.toObject();
    // Preserve the original gameName from Challonge (e.g., "The Legend of Zelda: Ocarina of Time Randomizer")
    // Only use game.name as fallback if gameName is not set
    if (tournamentObj.game && !tournamentObj.gameName) {
      tournamentObj.gameName = tournamentObj.game.name || tournamentObj.game.randomizer?.shortName || tournamentObj.game.id;
    }
    tournamentObj.status = calculateStatus(tournamentObj);

    res.json(tournamentObj);
  } catch (error) {
    next(error);
  }
});

// Get tournament matches
router.get('/:id/matches', validateObjectId('id'), async (req, res, next) => {
  try {
    const { Match, Tournament } = require('../models');
    
    // First check if tournament has embedded matches (Start.gg)
    const tournament = await Tournament.findById(req.params.id).lean();
    
    if (tournament && tournament.matches && tournament.matches.length > 0) {
      // Start.gg tournament - return embedded matches formatted like Challonge matches
      const formattedMatches = tournament.matches.map(m => ({
        _id: m.startggSetId || m._id,
        tournamentId: tournament._id,
        state: m.completedAt ? 'complete' : (m.state === 1 ? 'pending' : 'open'),
        round: m.round,
        player1Name: m.player1?.name || 'TBD',
        player2Name: m.player2?.name || 'TBD',
        player1Id: m.player1?.startggEntrantId,
        player2Id: m.player2?.startggEntrantId,
        scoresCsv: m.displayScore,
        completedAt: m.completedAt,
        winnerId: m.winnerId,
        groupId: null, // Start.gg uses phases instead
        phase: m.phase,
        phaseGroup: m.phaseGroup,
        identifier: m.phaseGroup ? `${m.phaseGroup}-R${m.round}` : `R${m.round}`
      }));
      
      return res.json({ matches: formattedMatches });
    }
    
    // Challonge tournament - fetch from Match collection
    const matches = await Match.find({ tournamentId: req.params.id })
      .sort({ round: 1, completedAt: -1 });

    res.json({ matches });
  } catch (error) {
    next(error);
  }
});

// Get tournament races
router.get('/:id/races', async (req, res, next) => {
  try {
    const { Race } = require('../models');
    const races = await Race.find({ tournamentId: req.params.id })
      .sort({ startedAt: -1 });

    res.json({ races });
  } catch (error) {
    next(error);
  }
});

// Helper function to calculate tournament status
function calculateStatus(tournament) {
  const today = new Date();
  const startDate = new Date(tournament.startDate);
  const endDate = new Date(tournament.endDate);
  
  if (today < startDate) return 'à venir';
  if (today >= startDate && today <= endDate) return 'en cours';
  return 'terminé';
}

module.exports = router;
