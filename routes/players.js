const express = require('express');
const router = express.Router();
const { Player, Tournament, Race } = require('../models');
const { getCanonicalName, normalizePlayerName } = require('../config/player-aliases');

// Normalize name for matching (lowercase, trim, remove accents)
function normalizeName(name) {
  if (!name) return '';
  return name.toString()
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

// Get all players from tournaments with race counts per game
router.get('/', async (req, res, next) => {
  try {
    // Get all tournaments with participants
    const tournaments = await Tournament.find({}).populate('gameId');
    
    // Get all Player documents (for racetime/twitch info)
    const playerDocs = await Player.find({});
    const playerDocsByName = new Map();
    playerDocs.forEach(p => {
      playerDocsByName.set(normalizeName(p.name), p);
    });
    
    // Get all races to count per player per game
    const races = await Race.find({}, { category: 1, entrants: 1 });
    
    // Build race counts per player per game (by normalized name)
    const raceCountsByPlayer = new Map(); // normalizedName -> { gameSlug -> count }
    
    races.forEach(race => {
      const gameSlug = race.category || '';
      if (race.entrants && Array.isArray(race.entrants)) {
        race.entrants.forEach(entrant => {
          const playerName = entrant.userName || entrant.userId;
          if (!playerName) return;
          
          // Resolve to canonical name via aliases
          const canonicalName = getCanonicalName(playerName);
          const normalized = normalizeName(canonicalName);
          
          if (!raceCountsByPlayer.has(normalized)) {
            raceCountsByPlayer.set(normalized, new Map());
          }
          const playerGames = raceCountsByPlayer.get(normalized);
          playerGames.set(gameSlug, (playerGames.get(gameSlug) || 0) + 1);
        });
      }
    });
    
    // Extract all unique players
    const playersMap = new Map();
    
    tournaments.forEach(tournament => {
      if (tournament.participants && Array.isArray(tournament.participants)) {
        tournament.participants.forEach(participant => {
          const playerName = participant.displayName || participant.name;
          
          // Resolve to canonical name via aliases
          const canonicalName = getCanonicalName(playerName);
          const normalized = normalizeName(canonicalName);
          
          if (!playersMap.has(normalized)) {
            // Try to get Player document info using canonical name
            const playerDoc = playerDocsByName.get(normalized);
            
            playersMap.set(normalized, {
              name: canonicalName, // Use canonical name
              games: new Set(),
              tournaments: [],
              racetimeUrl: playerDoc?.racetimeUrl || null,
              racetimeId: playerDoc?.racetimeId || playerDoc?.userId || null,
              twitch: playerDoc?.twitch || null
            });
          }
          
          const player = playersMap.get(normalized);
          
          // Add game to the player's games set
          if (tournament.gameId) {
            player.games.add(tournament.gameName || tournament.gameId.name);
          }
          
          // Add tournament info
          player.tournaments.push({
            tournamentId: tournament._id,
            tournamentName: tournament.name,
            gameName: tournament.gameName || (tournament.gameId ? tournament.gameId.name : null),
            finalRank: participant.finalRank,
            seed: participant.seed
          });
        });
      }
    });
    
    // Game slug to display name mapping
    const gameDisplayNames = {
      'oot': 'Ocarina of Time Randomizer',
      'ootr': 'Ocarina of Time Randomizer',
      'alttp': 'A Link to the Past Randomizer',
      'alttpr': 'A Link to the Past Randomizer',
      'mm': 'Majora\'s Mask Randomizer',
      'mmr': 'Majora\'s Mask Randomizer',
      'sm': 'Super Metroid Randomizer',
      'smr': 'Super Metroid Randomizer',
      'sm64': 'Super Mario 64 Randomizer',
      'dk64': 'Donkey Kong 64 Randomizer',
      'dk64r': 'Donkey Kong 64 Randomizer',
      'tww': 'The Wind Waker Randomizer',
      'tp': 'Twilight Princess Randomizer',
      'kh2fm': 'Kingdom Hearts 2 FM Randomizer',
      'sotn': 'Symphony of the Night Randomizer',
      'smz3': 'SMZ3 Combo Randomizer',
      'ootmm': 'OoT+MM Combo Randomizer'
    };
    
    // Convert Map to array and sort alphabetically
    const players = Array.from(playersMap.entries()).map(([normalized, player]) => {
      // Get race counts for this player using normalized name
      const playerRaceCounts = raceCountsByPlayer.get(normalized) || new Map();
      
      // Convert to array and sort by count descending, take top 4
      const racesByGame = Array.from(playerRaceCounts.entries())
        .map(([slug, count]) => ({
          gameSlug: slug,
          gameName: gameDisplayNames[slug.toLowerCase()] || slug,
          count
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 4);
      
      return {
        name: player.name,
        games: Array.from(player.games).sort(),
        tournamentsCount: player.tournaments.length,
        tournaments: player.tournaments,
        racesByGame,
        racetimeUrl: player.racetimeUrl,
        racetimeId: player.racetimeId,
        twitch: player.twitch
      };
    }).sort((a, b) => a.name.localeCompare(b.name));

    res.json({
      players,
      total: players.length
    });
  } catch (error) {
    next(error);
  }
});

// Get player by ID
// Get player by name (search Player collection)
router.get('/by-name/:name', async (req, res, next) => {
  try {
    // Case-insensitive search
    const player = await Player.findOne({ 
      name: { $regex: new RegExp('^' + req.params.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') }
    }).populate('tournaments.tournamentId');

    if (!player) {
      return res.status(204).end();
    }

    res.json(player);
  } catch (error) {
    next(error);
  }
});

// Get races by player name (searches by userName in entrants)
router.get('/by-name/:name/races', async (req, res, next) => {
  try {
    const { Race } = require('../models');
    const name = req.params.name;
    
    // Search races where entrants.userName matches (case-insensitive)
    const races = await Race.find({ 
      'entrants.userName': { $regex: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') }
    }).sort({ startedAt: -1 });

    res.json({ races });
  } catch (error) {
    next(error);
  }
});

// Get player races by userId
router.get('/:id/races', async (req, res, next) => {
  try {
    const { Race } = require('../models');
    const races = await Race.find({ 'entrants.userId': req.params.id })
      .sort({ startedAt: -1 });

    res.json({ races });
  } catch (error) {
    next(error);
  }
});

// Get player by ID
router.get('/:id', async (req, res, next) => {
  try {
    const player = await Player.findOne({ userId: req.params.id })
      .populate('tournaments.tournamentId');

    if (!player) {
      return res.status(204).end();
    }

    res.json(player);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
