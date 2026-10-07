const express = require('express');
const router = express.Router();
const { Tournament, Game } = require('../models');
const { validateObjectId } = require('../middleware/security');
const racetimeAPI = require('../services/racetime');
const { buildTournamentQuery } = require('../helpers/game-matching');

function extractRaceSlug(race) {
  const externalId = race?.source?.externalId;
  if (externalId && !String(externalId).includes('/')) return String(externalId);

  const raw = String(race?.url || race?.name || '').replace(/^https?:\/\/(www\.)?racetime\.gg/i, '');
  const parts = raw.replace(/^\/+/, '').split('/').filter(Boolean);
  return parts.length >= 2 ? parts[1] : null;
}

// Races imported without their entrant names; a few nameless entrants are
// deleted racetime accounts, which a reload would not bring back
function raceNeedsEntrantHydration(race) {
  const entrants = Array.isArray(race?.entrants) ? race.entrants : [];
  if (!entrants.length) return false;
  return entrants.every((entrant) => {
    const name = entrant?.userName || entrant?.user?.name || entrant?.name || entrant?.displayName || null;
    return !name;
  });
}

async function hydrateMissingRaceEntrants(races, Race) {
  const hydrated = [];

  for (const race of races) {
    if (!raceNeedsEntrantHydration(race) || !race?.category) {
      hydrated.push(race);
      continue;
    }

    const raceSlug = extractRaceSlug(race);
    if (!raceSlug) {
      hydrated.push(race);
      continue;
    }

    try {
      const freshRace = await racetimeAPI.getRace(race.category, raceSlug);
      if (!freshRace || !Array.isArray(freshRace.entrants) || !freshRace.entrants.length) {
        hydrated.push(race);
        continue;
      }

      await Race.updateOne(
        { _id: race._id },
        {
          $set: {
            entrants: racetimeAPI.toStoredEntrants(freshRace.entrants),
            goal: freshRace.goal || race.goal,
            info: freshRace.info || race.info,
            status: freshRace.status || race.status,
            startedAt: freshRace.startedAt || race.startedAt,
            endedAt: freshRace.endedAt || race.endedAt
          },
          $currentDate: { updatedAt: true }
        }
      );

      hydrated.push({ ...race, ...freshRace, entrants: racetimeAPI.toStoredEntrants(freshRace.entrants), _id: race._id, tournamentId: race.tournamentId, startggSetId: race.startggSetId, matchPlayers: race.matchPlayers, matchConfidence: race.matchConfidence, tournamentPhase: race.tournamentPhase, tournamentPool: race.tournamentPool, tournamentRound: race.tournamentRound, source: race.source });
    } catch (error) {
      console.warn(`Unable to hydrate race entrants for ${race.category}/${raceSlug}:`, error.message);
      hydrated.push(race);
    }
  }

  return hydrated;
}

// Get all tournaments
router.get('/', async (req, res, next) => {
  try {
    const { gameId, status, limit = 50, page = 1 } = req.query;
    
    const query = {};
    
    // Filter by game, using the same rules as the game pages
    if (gameId) {
      const gameIdLower = String(gameId).toLowerCase();
      const gameDoc = await Game.findOne({ id: gameIdLower }).select('_id name official randomizer').lean();
      Object.assign(query, buildTournamentQuery(gameDoc, gameIdLower));
    }
    
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);

    // The status is computed from the dates, so a status filter has to look at
    // every tournament before paginating; otherwise paginate in the database.
    let tournamentsQuery = Tournament.find(query)
      .populate('game', 'id name official randomizer')
      .sort({ startDate: -1 });
    if (!status) {
      tournamentsQuery = tournamentsQuery
        .limit(limitNum)
        .skip((pageNum - 1) * limitNum);
    }
    const tournaments = await tournamentsQuery;

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

    // Filter by status if requested, then paginate the matching tournaments
    let pageTournaments = tournamentsWithStatus;
    let total;
    if (status) {
      const filtered = tournamentsWithStatus.filter(t => t.status === status);
      total = filtered.length;
      pageTournaments = filtered.slice((pageNum - 1) * limitNum, pageNum * limitNum);
    } else {
      total = await Tournament.countDocuments(query);
    }

    res.json({
      tournaments: pageTournaments,
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
        // IMPORTANT: The player order in displayScore may differ from the match's player1/player2,
        // so we must match names to assign scores to the correct player.
        let scoresCsv = null;
        let winnerId = m.winnerId ? Number(m.winnerId) : null;
        if (m.displayScore && typeof m.displayScore === 'string') {
          const ds = m.displayScore.trim();
          const dashParts = ds.split(' - ');
          if (dashParts.length === 2) {
            const p1Part = dashParts[0].trim(); // displayScore left side
            const p2Part = dashParts[1].trim(); // displayScore right side
            
            // Extract trailing number or W/L from each part
            const p1ScoreMatch = p1Part.match(/\s+(\d+)$/);
            const p2ScoreMatch = p2Part.match(/\s+(\d+)$/);
            const p1W = p1Part.endsWith(' W');
            const p2W = p2Part.endsWith(' W');
            
            // Extract player names from displayScore parts (strip trailing score/W/L)
            let dsName1 = p1Part.replace(/\s+(W|L|\d+)$/, '').trim();
            let dsName2 = p2Part.replace(/\s+(W|L|\d+)$/, '').trim();
            
            // Determine raw scores from displayScore (in displayScore order)
            let dsScore1 = null, dsScore2 = null;
            if (p1ScoreMatch && p2ScoreMatch) {
              dsScore1 = parseInt(p1ScoreMatch[1]);
              dsScore2 = parseInt(p2ScoreMatch[1]);
            } else if (p1W || p2W) {
              dsScore1 = p1W ? 1 : 0;
              dsScore2 = p2W ? 1 : 0;
            }
            
            if (dsScore1 !== null && dsScore2 !== null) {
              // Match displayScore names to actual player1Name/player2Name
              // to assign scores correctly
              const norm = s => (s || '').toLowerCase().trim();
              const dsN1 = norm(dsName1);
              const dsN2 = norm(dsName2);
              const matchP1 = norm(player1Name);
              const matchP2 = norm(player2Name);
              
              // Check if displayScore order matches match order or is swapped
              const dsFirstIsPlayer1 = dsN1 === matchP1 || matchP1.includes(dsN1) || dsN1.includes(matchP1);
              const dsFirstIsPlayer2 = dsN1 === matchP2 || matchP2.includes(dsN1) || dsN1.includes(matchP2);
              
              if (dsFirstIsPlayer2 && !dsFirstIsPlayer1) {
                // displayScore order is swapped relative to match — swap scores
                scoresCsv = `${dsScore2}-${dsScore1}`;
              } else {
                // displayScore order matches match order (or we can't determine — keep original)
                scoresCsv = `${dsScore1}-${dsScore2}`;
              }
            }
            
            // Resolve winnerId from displayScore if not set
            if (!winnerId) {
              if (p1W || (p1ScoreMatch && p2ScoreMatch && parseInt(p1ScoreMatch[1]) > parseInt(p2ScoreMatch[1]))) {
                // displayScore left-side player won — match to the correct entrant
                const norm = s => (s || '').toLowerCase().trim();
                const dsWinnerName = norm(dsName1);
                if (norm(player1Name).includes(dsWinnerName) || dsWinnerName.includes(norm(player1Name))) {
                  winnerId = player1Id;
                } else {
                  winnerId = player2Id;
                }
              } else if (p2W || (p1ScoreMatch && p2ScoreMatch && parseInt(p2ScoreMatch[1]) > parseInt(p1ScoreMatch[1]))) {
                const norm = s => (s || '').toLowerCase().trim();
                const dsWinnerName = norm(dsName2);
                if (norm(player1Name).includes(dsWinnerName) || dsWinnerName.includes(norm(player1Name))) {
                  winnerId = player1Id;
                } else {
                  winnerId = player2Id;
                }
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
          player1Members: m.player1?.members || [],
          player2Members: m.player2?.members || [],
          player1Id,
          player2Id,
          scoresCsv,
          displayScore: m.displayScore || null,
          completedAt: m.completedAt,
          winnerId,
          groupId: null, // Start.gg uses phases instead
          phase: m.phase,
          phaseGroup: m.phaseGroup,
          raceUrl: m.raceUrl || null,
          raceUrls: Array.isArray(m.raceUrls) ? m.raceUrls : (m.raceUrl ? [m.raceUrl] : []),
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

    const hydratedRaces = await hydrateMissingRaceEntrants(races.map((race) => race.toObject()), Race);

    res.json({ races: hydratedRaces });
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
