const express = require('express');
const router = express.Router();
const { Tournament, Game } = require('../models');
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
    
    // Filter by game using game reference and/or gameName patterns
    if (gameId) {
      const gameIdLower = String(gameId).toLowerCase();
      const gamePattern = GAME_NAME_PATTERNS[gameIdLower];
      const gameDoc = await Game.findOne({ id: gameIdLower }).select('_id name official randomizer').lean();

      const orConditions = [];
      if (gameDoc?._id) {
        orConditions.push({ game: gameDoc._id });
      }
      if (gamePattern) {
        orConditions.push({ gameName: { $regex: gamePattern } });
      }
      if (gameDoc?.name) {
        const escapedName = gameDoc.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        orConditions.push({ gameName: { $regex: new RegExp(escapedName, 'i') } });
      }
      if (gameDoc?.official?.name) {
        const escapedOfficial = gameDoc.official.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        orConditions.push({ gameName: { $regex: new RegExp(escapedOfficial, 'i') } });
      }

      if (orConditions.length > 0) {
        query.$or = orConditions;
      }
    }
    
    const tournaments = await Tournament.find(query)
      .populate('game', 'id name official randomizer')
      .sort({ startDate: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));

    const total = await Tournament.countDocuments(query);

    // Calculate status dynamically
    const tournamentsWithStatus = tournaments.map(t => {
      const tournament = t.toObject();

      if (tournament.game && typeof tournament.game === 'object') {
        const g = tournament.game;
        if (g.id) {
          tournament.gameId = g.id;
        }
        if (!tournament.gameName) {
          tournament.gameName = g.official?.name || g.name || g.randomizer?.shortName || tournament.gameId || null;
        }
      }

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
      const formattedMatches = tournament.matches.map(m => {
        const player1Name = m.player1?.name || 'TBD';
        const player2Name = m.player2?.name || 'TBD';
        // Ensure consistent types for ID comparison on frontend (all numbers)
        const player1Id = m.player1?.startggEntrantId ? Number(m.player1.startggEntrantId) : null;
        const player2Id = m.player2?.startggEntrantId ? Number(m.player2.startggEntrantId) : null;

        // Parse Start.gg displayScore to extract numeric scores
        // Format: "PlayerA 2 - PlayerB 1" or "PlayerA W - PlayerB L" or "DQ" etc.
        let scoresCsv = null;
        let winnerId = m.winnerId ? Number(m.winnerId) : null;
        if (m.displayScore && typeof m.displayScore === 'string') {
          const ds = m.displayScore.trim();
          const dashParts = ds.split(' - ');
          if (dashParts.length === 2) {
            const p1Part = dashParts[0].trim();
            const p2Part = dashParts[1].trim();
            
            // Extract trailing number or W/L from each part
            const p1ScoreMatch = p1Part.match(/\s+(\d+)$/);
            const p2ScoreMatch = p2Part.match(/\s+(\d+)$/);
            const p1W = p1Part.endsWith(' W');
            const p2W = p2Part.endsWith(' W');
            
            if (p1ScoreMatch && p2ScoreMatch) {
              // BO3/BO5 format: "PlayerA 2 - PlayerB 1" -> "2-1"
              scoresCsv = `${p1ScoreMatch[1]}-${p2ScoreMatch[1]}`;
            } else if (p1W || p2W) {
              // Win/Loss format: "PlayerA W - PlayerB L" -> "1-0" or "0-1"
              scoresCsv = p1W ? '1-0' : '0-1';
            }
            
            // Resolve winnerId from displayScore if not set
            if (!winnerId) {
              if (p1W || (p1ScoreMatch && p2ScoreMatch && parseInt(p1ScoreMatch[1]) > parseInt(p2ScoreMatch[1]))) {
                winnerId = player1Id;
              } else if (p2W || (p1ScoreMatch && p2ScoreMatch && parseInt(p2ScoreMatch[1]) > parseInt(p1ScoreMatch[1]))) {
                winnerId = player2Id;
              }
            }
          } else if (ds === 'DQ') {
            scoresCsv = 'DQ';
          }
        }

        return {
          _id: m.startggSetId || m._id,
          startggSetId: m.startggSetId || null,
          tournamentId: tournament._id,
          state: m.completedAt ? 'complete' : (m.state === 1 ? 'pending' : 'open'),
          round: m.round,
          player1Name,
          player2Name,
          player1Id,
          player2Id,
          scoresCsv,
          displayScore: m.displayScore || null,
          completedAt: m.completedAt,
          winnerId,
          groupId: null, // Start.gg uses phases instead
          phase: m.phase,
          phaseGroup: m.phaseGroup,
          identifier: m.phaseGroup ? `${m.phaseGroup}-R${m.round}` : `R${m.round}`
        };
      });
      
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
