const express = require('express');
const router = express.Router();
const { Game, Tournament, Race, Player } = require('../models');
const { gameLabel: labelOfGame, loadGameLabels, tournamentGameLabel } = require('../helpers/game-label');

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Normalize name for matching (lowercase, trim, remove accents)
function normalizeName(name) {
  if (!name) return '';
  return name.toString()
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

// Global search endpoint
router.get('/', async (req, res, next) => {
  try {
    const { q, limit = 10 } = req.query;
    
    if (!q || q.trim().length < 2) {
      return res.json({
        query: q || '',
        results: {
          games: [],
          races: [],
          tournaments: [],
          players: []
        },
        counts: {
          games: 0,
          races: 0,
          tournaments: 0,
          players: 0,
          total: 0
        }
      });
    }

    const searchTerm = q.trim().slice(0, 100);
    const searchRegex = new RegExp(escapeRegex(searchTerm), 'i');
    const normalizedSearch = normalizeName(searchTerm);
    const limitNum = Math.min(parseInt(limit) || 10, 50);

        // Derive game categories from query (so part of a game's name matches its races)
        function categoriesFromQuery(q) {
          const s = normalizeName(q);
          const cats = new Set();
          const addAll = (arr) => arr.forEach(x => cats.add(x));

          if (/ocarina|\boot\b|\bootr\b/.test(s)) addAll(['oot','ootr']);
          if (/legend.*ocarina.*time/.test(s)) addAll(['oot','ootr']);
          if (/majora|\bmm\b|mmr\b/.test(s)) addAll(['mm','mmr']);
          if (/link.*past|\balttp\b|alttpr\b/.test(s)) addAll(['alttp','alttpr']);
          if (/super.*metroid|\bsm\b|smr\b/.test(s)) addAll(['sm','smr']);
          if (/super.*mario.*64|\bsm64\b/.test(s)) addAll(['sm64']);
          if (/donkey.*kong.*64|\bdk64\b|\bdk64r\b/.test(s)) addAll(['dk64','dk64r']);
          if (/wind.*waker|\btww\b/.test(s)) addAll(['tww']);
          if (/twilight.*princess|\btp\b/.test(s)) addAll(['tp']);
          if (/kingdom.*hearts.*(2|ii)|\bkh2\b/.test(s)) addAll(['kh2fm','kh2fmr','kh2r']);
          if (/symphony.*night|\bsotn\b/.test(s)) addAll(['sotn']);
          if (/smz3|super.*metroid.*link|link.*super.*metroid/.test(s)) addAll(['smz3']);
          if (/ootmm|ocarina.*majora/.test(s)) addAll(['ootmm','oot','ootr','mm','mmr']);

          return Array.from(cats);
        }

        const inferredCategories = categoriesFromQuery(searchTerm);

    // 1. Search Games
    const gameQuery = {
      $or: [
        { name: searchRegex },
        { 'official.name': searchRegex },
        { id: searchRegex }
      ]
    };
    const games = await Game.find(gameQuery).limit(limitNum);

    // 2. Search Tournaments (by name or game name)
    const tournaments = await Tournament.find({
      $or: [
        { name: searchRegex },
        { gameName: searchRegex }
      ]
    })
    .sort({ startDate: -1 })
    .limit(limitNum);

    // 3. Search Races (by name, goal, info, or category)
    const raceQuery = {
      $or: [
        { name: searchRegex },
        { goal: searchRegex },
        { info: searchRegex },
        { category: searchRegex },
        ...(inferredCategories.length ? [{ category: { $in: inferredCategories } }] : [])
      ]
    };

    const races = await Race.find(raceQuery)
    .sort({ startedAt: -1 })
    .limit(limitNum);

    // 4. Search Players
    // First, get Player documents
    const playerDocs = await Player.find({
      racetimeDeletedAt: null,
      $or: [
        { name: searchRegex },
        { racetimeId: searchRegex }
      ]
    }).limit(limitNum);

    // Also search in tournament participants and race entrants
    const tournamentsWithPlayers = await Tournament.find({
      'participants.displayName': searchRegex
    }).limit(20);

    const racesWithPlayers = await Race.find({
      $or: [
        { 'entrants.userName': searchRegex },
        { 'entrants.user.name': searchRegex }
      ]
    }).limit(50);

    // Build unique players map
    const playersMap = new Map();

    // Add from Player documents
    playerDocs.forEach(p => {
      const normalized = normalizeName(p.name);
      if (!playersMap.has(normalized)) {
        playersMap.set(normalized, {
          name: p.name,
          racetimeId: p.racetimeId || p.userId,
          racetimeUrl: p.racetimeUrl,
          twitch: p.twitch,
          games: new Set()
        });
      }
    });

    // Add from tournament participants
    tournamentsWithPlayers.forEach(tournament => {
      if (tournament.participants) {
        tournament.participants.forEach(participant => {
          const playerName = participant.displayName || participant.name;
          if (!playerName || !searchRegex.test(playerName)) return;
          
          const normalized = normalizeName(playerName);
          if (!playersMap.has(normalized)) {
            playersMap.set(normalized, {
              name: playerName,
              games: new Set()
            });
          }
          if (tournament.gameName) {
            playersMap.get(normalized).games.add(tournament.gameName);
          }
        });
      }
    });

    // Add from race entrants
    racesWithPlayers.forEach(race => {
      if (race.entrants) {
        race.entrants.forEach(entrant => {
          const playerName = entrant.userName || (entrant.user && entrant.user.name);
          if (!playerName || !searchRegex.test(playerName)) return;
          
          const normalized = normalizeName(playerName);
          if (!playersMap.has(normalized)) {
            playersMap.set(normalized, {
              name: playerName,
              racetimeId: entrant.userId || (entrant.user && entrant.user.id),
              games: new Set()
            });
          }
          if (race.category) {
            playersMap.get(normalized).games.add(race.category);
          }
        });
      }
    });

    // Convert players map to array
    const players = Array.from(playersMap.values())
      .map(p => ({
        ...p,
        games: p.games
      }))
      .slice(0, limitNum);

    // Get counts (without limit for totals)
    const [gamesCount, tournamentsCount, racesCount] = await Promise.all([
      Game.countDocuments(gameQuery),
      Tournament.countDocuments({
        $or: [
          { name: searchRegex },
          { gameName: searchRegex }
        ]
      }),
      Race.countDocuments(raceQuery)
    ]);

    const playersCount = playersMap.size;
    const gameLabel = await loadGameLabels();

    res.json({
      query: searchTerm,
      results: {
        games: games.map(g => ({
          id: g.id,
          name: g.name,
          label: labelOfGame(g),
          officialName: g.official && g.official.name,
          icon: g.icon
        })),
        tournaments: tournaments.map(t => ({
          _id: t._id,
          name: t.name,
          gameName: tournamentGameLabel(t, gameLabel),
          startDate: t.startDate,
          endDate: t.endDate,
          participantCount: t.participants ? t.participants.length : 0
        })),
        races: races.map(r => ({
          _id: r._id,
          name: r.name,
          category: r.category,
          gameName: gameLabel(r.category),
          goal: r.goal,
          status: r.status,
          startedAt: r.startedAt,
          entrantCount: r.entrants ? r.entrants.length : 0
        })),
        players: players.map(p => ({
          ...p,
          games: [...new Set(Array.from(p.games).map(g => gameLabel(g) || g))]
        }))
      },
      counts: {
        games: gamesCount,
        tournaments: tournamentsCount,
        races: racesCount,
        players: playersCount,
        total: gamesCount + tournamentsCount + racesCount + playersCount
      }
    });
  } catch (error) {
    console.error('Search error:', error);
    next(error);
  }
});

module.exports = router;
