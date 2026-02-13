const express = require('express');
const router = express.Router();
const { Player, Tournament, Race, Game } = require('../models');
const { getCanonicalName, normalizePlayerName } = require('../config/player-aliases');

const PLAYERS_CACHE_TTL = 5 * 60 * 1000;
const playersCache = {
  data: new Map(),
  expires: new Map(),
  inFlight: new Map()
};

// Normalize name for matching (lowercase, trim, remove accents)
function normalizeName(name) {
  if (!name) return '';
  return name.toString()
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function getPlayersCache(key) {
  const exp = playersCache.expires.get(key);
  if (exp && exp > Date.now()) {
    return playersCache.data.get(key);
  }
  return null;
}

function setPlayersCache(key, value) {
  playersCache.data.set(key, value);
  playersCache.expires.set(key, Date.now() + PLAYERS_CACHE_TTL);
}

function resolveGameDisplayNameFromDoc(game) {
  return game?.randomizer?.shortName
    || game?.randomizer?.displayName
    || game?.official?.name
    || game?.name
    || game?.id
    || null;
}

async function buildGameDisplayMaps() {
  const games = await Game.find({ enabled: { $ne: false } })
    .select('id name official randomizer integrations.racetime')
    .lean();

  const bySlug = new Map();

  const add = (slug, label) => {
    const s = String(slug || '').toLowerCase().trim();
    if (!s || !label) return;
    if (!bySlug.has(s)) bySlug.set(s, label);
  };

  for (const game of games) {
    const label = resolveGameDisplayNameFromDoc(game);
    const gameId = String(game.id || '').toLowerCase();
    const primarySlug = String(game?.integrations?.racetime?.gameSlug || '').toLowerCase();
    const extraSlugs = Array.isArray(game?.integrations?.racetime?.gameSlugs)
      ? game.integrations.racetime.gameSlugs.map(s => String(s || '').toLowerCase())
      : [];

    add(gameId, label);
    add(`${gameId}r`, label);
    add(primarySlug, label);
    extraSlugs.forEach(slug => add(slug, label));
  }

  const fallback = {
    oot: 'Ocarina of Time Randomizer',
    ootr: 'Ocarina of Time Randomizer',
    alttp: 'A Link to the Past Randomizer',
    alttpr: 'A Link to the Past Randomizer',
    mm: 'Majora\'s Mask Randomizer',
    mmr: 'Majora\'s Mask Randomizer',
    sm: 'Super Metroid Randomizer',
    smr: 'Super Metroid Randomizer',
    sm64: 'Super Mario 64 Randomizer',
    dk64: 'Donkey Kong 64 Randomizer',
    dk64r: 'Donkey Kong 64 Randomizer',
    tww: 'The Wind Waker Randomizer',
    tp: 'Twilight Princess Randomizer',
    kh2fm: 'Kingdom Hearts 2 FM Randomizer',
    sotn: 'Symphony of the Night Randomizer',
    smz3: 'SMZ3 Combo Randomizer',
    ootmm: 'OoT+MM Combo Randomizer',
    z1: 'The Legend of Zelda Randomizer',
    z1r: 'The Legend of Zelda Randomizer'
  };

  Object.entries(fallback).forEach(([slug, label]) => add(slug, label));

  return bySlug;
}

async function buildPlayersResponse(includeTournaments) {
  const gameDisplayBySlug = await buildGameDisplayMaps();

  const [playerDocs, tournamentParticipants, raceCounts] = await Promise.all([
    Player.find({}).select('name racetimeUrl racetimeId userId twitch').lean(),
    Tournament.aggregate([
      { $match: { participants: { $exists: true, $ne: [] } } },
      { $unwind: '$participants' },
      {
        $project: {
          tournamentId: '$_id',
          tournamentName: '$name',
          tournamentGameName: '$gameName',
          participantName: { $ifNull: ['$participants.displayName', '$participants.name'] },
          finalRank: '$participants.finalRank',
          seed: '$participants.seed'
        }
      },
      { $match: { participantName: { $nin: [null, ''] } } }
    ]),
    Race.aggregate([
      { $match: { entrants: { $exists: true, $ne: [] } } },
      { $unwind: '$entrants' },
      {
        $project: {
          category: '$category',
          entrantName: { $ifNull: ['$entrants.userName', '$entrants.userId'] }
        }
      },
      { $match: { entrantName: { $nin: [null, ''] }, category: { $nin: [null, ''] } } },
      {
        $group: {
          _id: {
            entrantName: '$entrantName',
            category: '$category'
          },
          count: { $sum: 1 }
        }
      }
    ])
  ]);

  const playerDocsByName = new Map();
  playerDocs.forEach(p => {
    playerDocsByName.set(normalizeName(p.name), p);
  });

  const raceCountsByPlayer = new Map();
  for (const row of raceCounts) {
    const rawName = row?._id?.entrantName;
    const category = String(row?._id?.category || '').toLowerCase();
    if (!rawName || !category) continue;

    const canonicalName = getCanonicalName(rawName);
    const normalized = normalizeName(canonicalName);
    if (!raceCountsByPlayer.has(normalized)) {
      raceCountsByPlayer.set(normalized, new Map());
    }

    const perGame = raceCountsByPlayer.get(normalized);
    perGame.set(category, (perGame.get(category) || 0) + (row.count || 0));
  }

  const playersMap = new Map();

  for (const row of tournamentParticipants) {
    const rawName = row.participantName;
    if (!rawName) continue;

    const canonicalName = getCanonicalName(rawName);
    const normalized = normalizeName(canonicalName);

    if (!playersMap.has(normalized)) {
      const playerDoc = playerDocsByName.get(normalized);
      playersMap.set(normalized, {
        name: canonicalName,
        games: new Set(),
        tournamentsCount: 0,
        tournaments: [],
        racetimeUrl: playerDoc?.racetimeUrl || null,
        racetimeId: playerDoc?.racetimeId || playerDoc?.userId || null,
        twitch: playerDoc?.twitch || null
      });
    }

    const player = playersMap.get(normalized);

    if (row.tournamentGameName) {
      player.games.add(row.tournamentGameName);
    }

    player.tournamentsCount += 1;

    if (includeTournaments) {
      player.tournaments.push({
        tournamentId: row.tournamentId,
        tournamentName: row.tournamentName,
        gameName: row.tournamentGameName || null,
        finalRank: row.finalRank,
        seed: row.seed
      });
    }
  }

  // Include player documents that may have no tournament rows
  for (const p of playerDocs) {
    const canonicalName = getCanonicalName(p.name);
    const normalized = normalizeName(canonicalName);
    if (!playersMap.has(normalized)) {
      playersMap.set(normalized, {
        name: canonicalName,
        games: new Set(),
        tournamentsCount: 0,
        tournaments: [],
        racetimeUrl: p?.racetimeUrl || null,
        racetimeId: p?.racetimeId || p?.userId || null,
        twitch: p?.twitch || null
      });
    }
  }

  const players = Array.from(playersMap.entries()).map(([normalized, player]) => {
    const playerRaceCounts = raceCountsByPlayer.get(normalized) || new Map();

    const racesByGame = Array.from(playerRaceCounts.entries())
      .map(([slug, count]) => ({
        gameSlug: slug,
        gameName: gameDisplayBySlug.get(String(slug || '').toLowerCase()) || slug,
        count
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 4);

    return {
      name: player.name,
      games: Array.from(player.games).sort(),
      tournamentsCount: player.tournamentsCount,
      tournaments: includeTournaments ? player.tournaments : [],
      racesByGame,
      racetimeUrl: player.racetimeUrl,
      racetimeId: player.racetimeId,
      twitch: player.twitch
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  return {
    players,
    total: players.length
  };
}

// Get all players from tournaments with race counts per game
router.get('/', async (req, res, next) => {
  try {
    const includeTournaments = req.query.includeTournaments === '1' || req.query.includeTournaments === 'true';
    const cacheKey = includeTournaments ? 'players:with-tournaments' : 'players:summary';

    const cached = getPlayersCache(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    if (playersCache.inFlight.has(cacheKey)) {
      const result = await playersCache.inFlight.get(cacheKey);
      return res.json(result);
    }

    const buildPromise = buildPlayersResponse(includeTournaments)
      .then(result => {
        setPlayersCache(cacheKey, result);
        return result;
      })
      .finally(() => {
        playersCache.inFlight.delete(cacheKey);
      });

    playersCache.inFlight.set(cacheKey, buildPromise);

    const result = await buildPromise;
    res.json(result);
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
