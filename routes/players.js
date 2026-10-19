const express = require('express');
const router = express.Router();
const { Player, Tournament, Race, Game, Match } = require('../models');
const { buildCommonTournaments, racetimeRoomPath } = require('../helpers/compare-tournaments');
const { buildPlayerTournaments } = require('../helpers/player-tournaments');
const { buildAliasIndex, loadAliasIndex, getCanonicalName, getAliases } = require('../helpers/player-aliases');
const { exactNameRegex, buildPlayerRacesFilter } = require('../helpers/player-races-filter');

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

// Upper bound on cached entries: lookups by arbitrary names must not let the
// cache grow without limit (memory exhaustion).
const PLAYERS_CACHE_MAX_ENTRIES = 1000;

function setPlayersCache(key, value) {
  if (!playersCache.data.has(key) && playersCache.data.size >= PLAYERS_CACHE_MAX_ENTRIES) {
    const now = Date.now();
    for (const [cachedKey, exp] of playersCache.expires) {
      if (exp <= now) {
        playersCache.expires.delete(cachedKey);
        playersCache.data.delete(cachedKey);
      }
    }
    // Still full: drop the oldest entries (Maps keep insertion order).
    while (playersCache.data.size >= PLAYERS_CACHE_MAX_ENTRIES) {
      const oldestKey = playersCache.data.keys().next().value;
      playersCache.data.delete(oldestKey);
      playersCache.expires.delete(oldestKey);
    }
  }
  playersCache.data.set(key, value);
  playersCache.expires.set(key, Date.now() + PLAYERS_CACHE_TTL);
}

function filterPlayersByName(payload, rawName) {
  const wanted = normalizeName(rawName);
  if (!wanted) return payload;

  const filteredPlayers = (payload.players || []).filter(p => normalizeName(p.name) === wanted);
  return {
    players: filteredPlayers,
    total: filteredPlayers.length
  };
}

function resolveGameDisplayNameFromDoc(game) {
  return game?.randomizer?.displayName
    || game?.randomizer?.shortName
    || game?.official?.name
    || game?.name
    || game?.id
    || null;
}

async function buildGameDisplayMaps() {
  const games = await Game.find({ enabled: { $ne: false } })
    .select('id name official randomizer integrations.racetime')
    .lean();

  const displayBySlug = new Map();
  const canonicalIdBySlug = new Map();

  const add = (slug, label, canonicalId) => {
    const s = String(slug || '').toLowerCase().trim();
    if (!s || !label) return;
    if (!displayBySlug.has(s)) displayBySlug.set(s, label);
    if (canonicalId && !canonicalIdBySlug.has(s)) canonicalIdBySlug.set(s, canonicalId);
  };

  for (const game of games) {
    const label = resolveGameDisplayNameFromDoc(game);
    const gameId = String(game.id || '').toLowerCase().trim();
    const primarySlug = String(game?.integrations?.racetime?.gameSlug || '').toLowerCase();
    const extraSlugs = Array.isArray(game?.integrations?.racetime?.gameSlugs)
      ? game.integrations.racetime.gameSlugs.map(s => String(s || '').toLowerCase())
      : [];

    add(gameId, label, gameId);
    add(`${gameId}r`, label, gameId);
    add(primarySlug, label, gameId);
    extraSlugs.forEach(slug => add(slug, label, gameId));
  }

  const fallback = {
    oot: { label: 'Ocarina of Time Randomizer', gameId: 'oot' },
    ootr: { label: 'Ocarina of Time Randomizer', gameId: 'oot' },
    alttp: { label: 'A Link to the Past Randomizer', gameId: 'alttp' },
    alttpr: { label: 'A Link to the Past Randomizer', gameId: 'alttp' },
    mm: { label: 'Majora\'s Mask Randomizer', gameId: 'mm' },
    mmr: { label: 'Majora\'s Mask Randomizer', gameId: 'mm' },
    sm: { label: 'Super Metroid Randomizer', gameId: 'sm' },
    smr: { label: 'Super Metroid Randomizer', gameId: 'sm' },
    sm64: { label: 'Super Mario 64 Randomizer', gameId: 'sm64' },
    dk64: { label: 'Donkey Kong 64 Randomizer', gameId: 'dk64' },
    dk64r: { label: 'Donkey Kong 64 Randomizer', gameId: 'dk64' },
    tww: { label: 'The Wind Waker Randomizer', gameId: 'tww' },
    tp: { label: 'Twilight Princess Randomizer', gameId: 'tp' },
    kh2fm: { label: 'Kingdom Hearts 2 FM Randomizer', gameId: 'kh2fm' },
    sotn: { label: 'Symphony of the Night Randomizer', gameId: 'sotn' },
    smz3: { label: 'SMZ3 Combo Randomizer', gameId: 'smz3' },
    ootmm: { label: 'OoT+MM Combo Randomizer', gameId: 'ootmm' },
    z1: { label: 'The Legend of Zelda Randomizer', gameId: 'z1' },
    z1r: { label: 'The Legend of Zelda Randomizer', gameId: 'z1' }
  };

  Object.entries(fallback).forEach(([slug, entry]) => add(slug, entry.label, entry.gameId));

  return { displayBySlug, canonicalIdBySlug };
}

async function buildPlayersResponse(includeTournaments) {
  const { displayBySlug: gameDisplayBySlug, canonicalIdBySlug: canonicalGameIdBySlug } = await buildGameDisplayMaps();

  const [playerDocs, tournamentParticipants, raceCounts] = await Promise.all([
    Player.find({}).select('name aliases racetimeUrl racetimeId userId twitch racetimeDeletedAt').lean(),
    Tournament.aggregate([
      { $match: { participants: { $exists: true, $ne: [] } } },
      { $unwind: '$participants' },
      {
        $project: {
          tournamentId: '$_id',
          tournamentName: '$name',
          tournamentGameName: '$gameName',
          participantName: { $ifNull: ['$participants.displayName', '$participants.name'] },
          racetimeUserId: '$participants.racetimeUserId',
          racetimeName: '$participants.racetimeName',
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
          startedAt: '$startedAt',
          userId: '$entrants.userId',
          entrantName: { $ifNull: ['$entrants.userName', '$entrants.userId'] }
        }
      },
      { $match: { entrantName: { $nin: [null, ''] }, category: { $nin: [null, ''] } } },
      {
        $group: {
          _id: {
            userId: '$userId',
            entrantName: '$entrantName',
            category: '$category'
          },
          count: { $sum: 1 },
          lastRaceAt: { $max: '$startedAt' }
        }
      }
    ])
  ]);

  // Accounts deleted from racetime leave the list (their races stay)
  const deletedUserIds = new Set(playerDocs.filter(p => p.racetimeDeletedAt).map(p => p.userId));
  const aliasIndex = buildAliasIndex(playerDocs);
  const playerDocsByName = new Map();
  const playerDocsByUserId = new Map();
  playerDocs.forEach(p => {
    playerDocsByName.set(normalizeName(p.name), p);
    if (p.userId) playerDocsByUserId.set(p.userId, p);
  });

  const raceCountsByPlayer = new Map();
  // Most recent race of each player, for the "recently active" sort
  const lastRaceByPlayer = new Map();
  for (const row of raceCounts) {
    if (deletedUserIds.has(row?._id?.userId)) continue;
    // A racetime account is one player whatever name it raced under: its current name
    const rawName = playerDocsByUserId.get(row?._id?.userId)?.name || row?._id?.entrantName;
    const category = String(row?._id?.category || '').toLowerCase();
    if (!rawName || !category) continue;

    const canonicalName = getCanonicalName(aliasIndex, rawName);
    const normalized = normalizeName(canonicalName);
    if (!raceCountsByPlayer.has(normalized)) {
      raceCountsByPlayer.set(normalized, new Map());
    }

    const perGame = raceCountsByPlayer.get(normalized);
    perGame.set(category, (perGame.get(category) || 0) + (row.count || 0));

    const last = row.lastRaceAt ? new Date(row.lastRaceAt) : null;
    if (last && !(lastRaceByPlayer.get(normalized) >= last)) lastRaceByPlayer.set(normalized, last);
  }

  const playersMap = new Map();
  const playersWithRaces = new Set(raceCountsByPlayer.keys());

  for (const row of tournamentParticipants) {
    if (deletedUserIds.has(row.racetimeUserId)) continue;
    // The racetime account that raced the participant's matches, rather than the bracket name
    const rawName = playerDocsByUserId.get(row.racetimeUserId)?.name || row.racetimeName || row.participantName;
    if (!rawName) continue;

    const canonicalName = getCanonicalName(aliasIndex, rawName);
    const normalized = normalizeName(canonicalName);
    if (!playersWithRaces.has(normalized)) continue;

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
    if (p.racetimeDeletedAt) continue;
    const canonicalName = getCanonicalName(aliasIndex, p.name);
    const normalized = normalizeName(canonicalName);
    if (!playersWithRaces.has(normalized)) continue;
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

    // Merge racetime categories that belong to the same game
    const racesByGameId = new Map();
    for (const [slug, count] of playerRaceCounts.entries()) {
      const lowerSlug = String(slug || '').toLowerCase();
      const gameId = canonicalGameIdBySlug.get(lowerSlug) || lowerSlug;
      const existing = racesByGameId.get(gameId);
      if (existing) {
        existing.count += count;
        continue;
      }
      racesByGameId.set(gameId, {
        gameId,
        gameSlug: slug,
        gameName: gameDisplayBySlug.get(lowerSlug) || slug,
        count
      });
    }

    const totalRaces = Array.from(racesByGameId.values()).reduce((sum, g) => sum + g.count, 0);
    const racesByGame = Array.from(racesByGameId.values())
      .sort((a, b) => b.count - a.count || String(a.gameSlug).localeCompare(String(b.gameSlug)))
      .slice(0, 3);

    return {
      name: player.name,
      games: Array.from(player.games).sort(),
      tournamentsCount: player.tournamentsCount,
      tournaments: includeTournaments ? player.tournaments : [],
      racesByGame,
      totalRaces,
      lastRaceAt: lastRaceByPlayer.get(normalized) || null,
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

// Compare two players: head-to-head stats from common races
router.get('/compare', async (req, res, next) => {
  try {
    const name1 = (req.query.player1 || '').toString().trim();
    const name2 = (req.query.player2 || '').toString().trim();
    if (!name1 || !name2) {
      return res.status(400).json({ error: 'Both player1 and player2 query params are required' });
    }

    const aliasIndex = await loadAliasIndex(Player);
    const canonical1 = getCanonicalName(aliasIndex, name1);
    const canonical2 = getCanonicalName(aliasIndex, name2);
    const norm1 = normalizeName(canonical1);
    const norm2 = normalizeName(canonical2);

    if (norm1 === norm2) {
      return res.status(400).json({ error: 'Cannot compare a player with themselves' });
    }

    // Collect all name variants (canonical + aliases) for each player
    const aliases1 = [canonical1, name1, ...getAliases(aliasIndex, canonical1)];
    const aliases2 = [canonical2, name2, ...getAliases(aliasIndex, canonical2)];

    const nameSet1 = new Set(aliases1.map(n => normalizeName(n)));
    const nameSet2 = new Set(aliases2.map(n => normalizeName(n)));

    // Build regex patterns to match any alias for each player
    const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const makeOrRegex = names => new RegExp(
      Array.from(names).map(n => `^${escapeRegex(n)}$`).join('|'), 'i'
    );
    const regex1 = makeOrRegex(new Set(aliases1));
    const regex2 = makeOrRegex(new Set(aliases2));

    // Find races where BOTH players appear in entrants
    const commonRaces = await Race.find({
      'entrants.userName': { $all: [regex1, regex2] }
    }).sort({ startedAt: -1 }).lean();

    // Build game display map for category → game name mapping
    const { displayBySlug: gameDisplayBySlug, canonicalIdBySlug: gameIdBySlug } = await buildGameDisplayMaps();

    let p1Wins = 0;
    let p2Wins = 0;
    let draws = 0;
    const raceDetails = [];

    for (const race of commonRaces) {
      const entrant1 = race.entrants.find(e => nameSet1.has(normalizeName(e.userName)));
      const entrant2 = race.entrants.find(e => nameSet2.has(normalizeName(e.userName)));
      if (!entrant1 || !entrant2) continue;

      const p1Place = entrant1.place || null;
      const p2Place = entrant2.place || null;
      const p1Finished = entrant1.status === 'done' || entrant1.status === 'finished';
      const p2Finished = entrant2.status === 'done' || entrant2.status === 'finished';

      // Head-to-head: who placed higher in THIS race?
      let h2hWinner = null;
      if (p1Finished && p2Finished) {
        if (p1Place && p2Place) {
          if (p1Place < p2Place) { p1Wins++; h2hWinner = 1; }
          else if (p2Place < p1Place) { p2Wins++; h2hWinner = 2; }
          else { draws++; h2hWinner = 0; }
        }
      } else if (p1Finished && !p2Finished) {
        p1Wins++; h2hWinner = 1;
      } else if (!p1Finished && p2Finished) {
        p2Wins++; h2hWinner = 2;
      } else {
        // Both DNF
        draws++; h2hWinner = 0;
      }

      const category = (race.category || '').toLowerCase();

      raceDetails.push({
        raceId: race._id,
        raceName: race.name,
        raceUrl: race.url,
        tournamentId: race.tournamentId || null,
        category: race.category,
        gameName: gameDisplayBySlug.get(category) || race.category || null,
        gameId: gameIdBySlug.get(category) || null,
        goal: race.goal || null,
        startedAt: race.startedAt,
        totalEntrants: race.entrants.length,
        player1: {
          name: entrant1.userName,
          place: p1Place,
          placeOrdinal: entrant1.placeOrdinal || null,
          status: entrant1.status,
          finishTime: entrant1.finishTime || null,
          finishTimeMs: entrant1.finishTimeMs || null
        },
        player2: {
          name: entrant2.userName,
          place: p2Place,
          placeOrdinal: entrant2.placeOrdinal || null,
          status: entrant2.status,
          finishTime: entrant2.finishTime || null,
          finishTimeMs: entrant2.finishTimeMs || null
        },
        h2hWinner
      });
    }

    // Aggregate placement distribution per player across common races
    const p1Placements = { first: 0, second: 0, third: 0, dnf: 0, other: 0 };
    const p2Placements = { first: 0, second: 0, third: 0, dnf: 0, other: 0 };

    for (const rd of raceDetails) {
      for (const [pKey, placements] of [['player1', p1Placements], ['player2', p2Placements]]) {
        const p = rd[pKey];
        const finished = p.status === 'done' || p.status === 'finished';
        if (!finished) { placements.dnf++; }
        else if (p.place === 1) { placements.first++; }
        else if (p.place === 2) { placements.second++; }
        else if (p.place === 3) { placements.third++; }
        else { placements.other++; }
      }
    }

    // Average finish times (only when both finished)
    let p1TotalMs = 0, p1Count = 0, p2TotalMs = 0, p2Count = 0;
    for (const rd of raceDetails) {
      if (rd.player1.finishTimeMs && (rd.player1.status === 'done' || rd.player1.status === 'finished')) {
        p1TotalMs += rd.player1.finishTimeMs;
        p1Count++;
      }
      if (rd.player2.finishTimeMs && (rd.player2.status === 'done' || rd.player2.status === 'finished')) {
        p2TotalMs += rd.player2.finishTimeMs;
        p2Count++;
      }
    }

    // Games breakdown
    const gameBreakdown = {};
    for (const rd of raceDetails) {
      const gn = rd.gameName || rd.category || 'Unknown';
      if (!gameBreakdown[gn]) gameBreakdown[gn] = { gameId: rd.gameId, count: 0, p1Wins: 0, p2Wins: 0, draws: 0 };
      gameBreakdown[gn].count++;
      if (rd.h2hWinner === 1) gameBreakdown[gn].p1Wins++;
      else if (rd.h2hWinner === 2) gameBreakdown[gn].p2Wins++;
      else if (rd.h2hWinner === 0) gameBreakdown[gn].draws++;
    }

    // Tournaments both entered: final ranks and the bracket matches between them
    const [playerDoc1, playerDoc2] = await Promise.all([canonical1, canonical2].map(name =>
      Player.findOne({ name: exactNameRegex(name) }).select('userId tournaments.tournamentId tournaments.finalRank').lean()
    ));
    const rankByTournament = doc => new Map((doc?.tournaments || [])
      .filter(t => t.tournamentId && t.finalRank)
      .map(t => [String(t.tournamentId), t.finalRank]));
    const raceIdByRoom = new Map(raceDetails.map(rd => [racetimeRoomPath(rd.raceUrl), rd.raceId]));
    const commonTournaments = await buildCommonTournaments({
      Tournament,
      Match,
      raceIdByRoom,
      players: [
        { key: 'player1', names: new Set(aliases1), userId: playerDoc1?.userId || null, rankByTournament: rankByTournament(playerDoc1) },
        { key: 'player2', names: new Set(aliases2), userId: playerDoc2?.userId || null, rankByTournament: rankByTournament(playerDoc2) }
      ]
    });

    // Tournament of each common race, to tell bracket races from casual ones
    const raceTournamentIds = [...new Set(raceDetails.map(rd => rd.tournamentId && String(rd.tournamentId)).filter(Boolean))];
    if (raceTournamentIds.length) {
      const names = new Map((await Tournament.find({ _id: { $in: raceTournamentIds } }).select('name').lean())
        .map(t => [String(t._id), t.name]));
      for (const rd of raceDetails) rd.tournamentName = rd.tournamentId ? names.get(String(rd.tournamentId)) || null : null;
    }

    res.json({
      player1: { name: canonical1 },
      player2: { name: canonical2 },
      totalCommonRaces: raceDetails.length,
      headToHead: {
        player1Wins: p1Wins,
        player2Wins: p2Wins,
        draws
      },
      winRate: {
        player1: raceDetails.length ? Math.round((p1Wins / raceDetails.length) * 1000) / 10 : 0,
        player2: raceDetails.length ? Math.round((p2Wins / raceDetails.length) * 1000) / 10 : 0
      },
      placements: {
        player1: p1Placements,
        player2: p2Placements
      },
      averageFinishTimeMs: {
        player1: p1Count ? Math.round(p1TotalMs / p1Count) : null,
        player2: p2Count ? Math.round(p2TotalMs / p2Count) : null
      },
      gameBreakdown: Object.entries(gameBreakdown)
        .map(([name, stats]) => ({ gameName: name, ...stats }))
        .sort((a, b) => b.count - a.count),
      commonTournaments,
      races: raceDetails
    });
  } catch (error) {
    next(error);
  }
});

// Get all players from tournaments with race counts per game
// Players list from the cache, built once when several requests ask at the same time
async function getPlayersList(includeTournaments) {
  const cacheKey = includeTournaments ? 'players:with-tournaments' : 'players:summary';

  const cached = getPlayersCache(cacheKey);
  if (cached) return cached;

  if (playersCache.inFlight.has(cacheKey)) {
    return playersCache.inFlight.get(cacheKey);
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
  return buildPromise;
}

router.get('/', async (req, res, next) => {
  try {
    const includeTournaments = req.query.includeTournaments === '1' || req.query.includeTournaments === 'true';
    const filterName = (req.query.name || '').toString();
    const result = await getPlayersList(includeTournaments);
    res.json(filterName ? filterPlayersByName(result, filterName) : result);
  } catch (error) {
    next(error);
  }
});

// Number of players only, for the home page and About page counters (the list weighs megabytes)
router.get('/count', async (req, res, next) => {
  try {
    const result = await getPlayersList(false);
    res.json({ total: result.total });
  } catch (error) {
    next(error);
  }
});

// Get player by ID
// Get player by name (search Player collection)
router.get('/by-name/:name', async (req, res, next) => {
  try {
    const normalizedName = normalizeName(req.params.name);
    const cacheKey = `players:by-name:${normalizedName}`;
    const cached = getPlayersCache(cacheKey);
    if (cached) {
      if (cached.__noContent) return res.status(204).end();
      return res.json(cached);
    }

    // Case-insensitive search, by name then by alias (the page redirects aliases to the canonical name)
    const nameRegex = exactNameRegex(req.params.name);
    const player = await Player.findOne({ name: nameRegex }).populate('tournaments.tournamentId')
      || await Player.findOne({ aliases: nameRegex }).populate('tournaments.tournamentId')
      || await findPlayerOfOtherName(req.params.name);

    if (!player) {
      setPlayersCache(cacheKey, { __noContent: true });
      return res.status(204).end();
    }

    setPlayersCache(cacheKey, player);
    res.json(player);
  } catch (error) {
    next(error);
  }
});

// ?compact=1 (player page): only the fields the page displays, and only the
// player's own entrant, instead of every entrant of every race (~10x smaller).
const COMPACT_RACE_FIELDS = 'name category goal info status startedAt endedAt createdAt updatedAt entrants.userId entrants.userName entrants.place entrants.status';

function isCompactRequest(req) {
  return req.query.compact === '1' || req.query.compact === 'true';
}

/**
 * Player of a name that is not its current one: a former racetime name (for an account
 * now named otherwise) or a bracket name (a start.gg gamer tag, shown in its sets as
 * "Prefix | GamerTag") linked to a racetime account. Only when the name leads to
 * a single account. The Player document, or `{ name }` of the racetime name when the
 * account has none; the player page redirects to it.
 */
async function findPlayerOfOtherName(name) {
  const tag = String(name).split(' | ').pop().trim();
  const tagRegex = exactNameRegex(tag);
  const nameRegex = exactNameRegex(name);
  const [participantAccounts, raceAccounts] = await Promise.all([
    Tournament.aggregate([
      { $match: { $or: [{ 'participants.name': tagRegex }, { 'participants.displayName': tagRegex }] } },
      { $unwind: '$participants' },
      { $match: { $or: [{ 'participants.name': tagRegex }, { 'participants.displayName': tagRegex }] } },
      { $match: { 'participants.racetimeUserId': { $nin: [null, ''] } } },
      { $group: { _id: '$participants.racetimeUserId', name: { $last: '$participants.racetimeName' } } }
    ]),
    Race.aggregate([
      { $match: { entrants: { $elemMatch: { userName: nameRegex, userId: { $nin: [null, ''] } } } } },
      { $unwind: '$entrants' },
      { $match: { 'entrants.userName': nameRegex, 'entrants.userId': { $nin: [null, ''] } } },
      { $group: { _id: '$entrants.userId', name: { $last: '$entrants.userName' } } }
    ])
  ]);
  const accounts = new Map([...participantAccounts, ...raceAccounts].map(row => [row._id, row.name]));
  if (accounts.size !== 1) return null;

  const [[userId, accountName]] = accounts;
  const player = await Player.findOne({ userId }).populate('tournaments.tournamentId');
  if (player) return player;
  return accountName && normalizeName(accountName) !== normalizeName(name) ? { name: accountName } : null;
}

/** Player document whose name, or one of whose aliases, is `name` (case-insensitive). */
async function findPlayerByNameOrAlias(name) {
  const regex = exactNameRegex(name);
  return await Player.findOne({ name: regex }).select('userId name aliases').lean()
    || await Player.findOne({ aliases: regex }).select('userId name aliases').lean();
}

function compactRaces(races, isPlayerEntrant) {
  return races.map(race => {
    // info is only shown (cut to 80 characters) when there is no goal
    const info = race.goal ? undefined : (race.info ? String(race.info).slice(0, 120) : race.info);
    return {
      ...race,
      info,
      entrants: (race.entrants || []).filter(isPlayerEntrant)
    };
  });
}

// Get races by player name (searches by userName in entrants)
router.get('/by-name/:name/races', async (req, res, next) => {
  try {
    const { Race } = require('../models');
    const name = req.params.name;
    const normalizedName = normalizeName(name);
    const compact = isCompactRequest(req);
    const cacheKey = `players:by-name-races${compact ? '-compact' : ''}:${normalizedName}`;
    const cached = getPlayersCache(cacheKey);
    if (cached) {
      return res.json(cached);
    }
    
    // The name itself, plus the player's userId and aliases when it belongs to a known player
    const player = await findPlayerByNameOrAlias(name);
    const { filter, isPlayerEntrant } = buildPlayerRacesFilter({
      userId: player?.userId,
      names: [name, player?.name],
      aliases: player?.aliases
    });
    const query = Race.find(filter).sort({ startedAt: -1 });

    const result = compact
      ? { races: compactRaces(await query.select(COMPACT_RACE_FIELDS).lean(), isPlayerEntrant) }
      : { races: await query };
    setPlayersCache(cacheKey, result);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Get player races by userId
router.get('/:id/races', async (req, res, next) => {
  try {
    const { Race } = require('../models');
    const userId = req.params.id;
    const player = await Player.findOne({ userId }).select('aliases').lean();
    const { filter, isPlayerEntrant } = buildPlayerRacesFilter({ userId, aliases: player?.aliases });
    const query = Race.find(filter)
      .sort({ startedAt: -1 });

    if (isCompactRequest(req)) {
      const cacheKey = `players:id-races-compact:${userId}`;
      const cached = getPlayersCache(cacheKey);
      if (cached) {
        return res.json(cached);
      }
      const races = await query.select(COMPACT_RACE_FIELDS).lean();
      const result = { races: compactRaces(races, isPlayerEntrant) };
      setPlayersCache(cacheKey, result);
      return res.json(result);
    }

    res.json({ races: await query });
  } catch (error) {
    next(error);
  }
});

// Get player by ID
// Tournaments of a player, by racetime account (or by name for a player without one)
async function sendPlayerTournaments(res, cacheKey, lookup) {
  const cached = getPlayersCache(cacheKey);
  if (cached) return res.json(cached);
  const { userId, names } = await lookup();
  const result = { tournaments: await buildPlayerTournaments({ Tournament, Match, userId, names }) };
  setPlayersCache(cacheKey, result);
  res.json(result);
}

router.get('/by-name/:name/tournaments', async (req, res, next) => {
  try {
    const name = req.params.name;
    await sendPlayerTournaments(res, `players:by-name-tournaments:${normalizeName(name)}`, async () => {
      const player = await findPlayerByNameOrAlias(name);
      return { userId: player?.userId || null, names: [name, player?.name, ...(player?.aliases || [])] };
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:id/tournaments', async (req, res, next) => {
  try {
    const userId = req.params.id;
    await sendPlayerTournaments(res, `players:id-tournaments:${userId}`, async () => {
      const player = await Player.findOne({ userId }).select('name aliases').lean();
      return { userId, names: [player?.name, ...(player?.aliases || [])] };
    });
  } catch (error) {
    next(error);
  }
});

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
