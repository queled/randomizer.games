const express = require('express');
const router = express.Router();
const { Tournament, Game } = require('../models');
const { validateObjectId } = require('../middleware/security');
const racetimeAPI = require('../services/racetime');
const { buildTournamentQuery } = require('../helpers/game-matching');
const { calculateTournamentStatus } = require('../helpers/tournament-status');
const { tournamentGameLabel } = require('../helpers/game-label');

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

// A page view reloads at most this many races from racetime.gg, and a race is
// not tried again for an hour: a visitor cannot make the server call racetime
// (and write to the database) once per race of a big tournament.
const MAX_HYDRATIONS_PER_REQUEST = 3;
const HYDRATION_RETRY_MS = 60 * 60 * 1000;
const HYDRATION_ATTEMPTS_MAX = 5000;
const hydrationAttempts = new Map();

function claimHydrationAttempt(raceId) {
  const key = String(raceId);
  const last = hydrationAttempts.get(key);
  if (last && Date.now() - last < HYDRATION_RETRY_MS) return false;
  if (!last && hydrationAttempts.size >= HYDRATION_ATTEMPTS_MAX) {
    hydrationAttempts.delete(hydrationAttempts.keys().next().value);
  }
  hydrationAttempts.delete(key);
  hydrationAttempts.set(key, Date.now());
  return true;
}

async function hydrateMissingRaceEntrants(races, Race) {
  const hydrated = [];
  let budget = MAX_HYDRATIONS_PER_REQUEST;

  for (const race of races) {
    if (!raceNeedsEntrantHydration(race) || !race?.category || budget <= 0 || !claimHydrationAttempt(race._id)) {
      hydrated.push(race);
      continue;
    }
    budget--;

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
        // The bracket's own game name stays in sourceGameName; gameName is the site's label
        tournament.sourceGameName = tournament.gameName || null;
        tournament.gameName = tournamentGameLabel(tournament);
      }

      tournament.status = calculateTournamentStatus(tournament);
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
    // The bracket's own game name stays in sourceGameName; gameName is the site's label
    if (tournamentObj.game) {
      tournamentObj.sourceGameName = tournamentObj.gameName || null;
      tournamentObj.gameName = tournamentGameLabel(tournamentObj);
    }
    tournamentObj.status = calculateTournamentStatus(tournamentObj);

    res.json(tournamentObj);
  } catch (error) {
    next(error);
  }
});

// "https://racetime.gg/<category>/<room>" or "/<category>/<room>" → "/<category>/<room>"
function racetimeRoomPath(url) {
  return String(url || '').replace(/^https?:\/\/(?:www\.)?racetime\.gg/i, '').replace(/\/+$/, '') || null;
}

// Restreams of the played races on Mido's House, by racetime.gg room
function midosHouseStreamsByRoom(tournament) {
  const byRoom = new Map();
  for (const entry of tournament?.midosHouse?.pastRestreams || []) {
    const room = racetimeRoomPath(entry.roomUrl);
    if (room) byRoom.set(room, (byRoom.get(room) || []).concat(entry.restreams || []));
  }
  return byRoom;
}

// Get tournament matches
router.get('/:id/matches', validateObjectId('id'), async (req, res, next) => {
  try {
    const { Match, Tournament } = require('../models');
    
    // First check if tournament has embedded matches (Start.gg)
    const tournament = await Tournament.findById(req.params.id).lean();
    
    if (tournament && tournament.matches && tournament.matches.length > 0) {
      // Next race of each set scheduled on Mido's House (several for a best-of)
      const nextRaceBySet = new Map();
      for (const entry of tournament.midosHouse?.schedule || []) {
        if (!entry.startggSetId || !entry.startAt) continue;
        const current = nextRaceBySet.get(entry.startggSetId);
        if (!current || new Date(entry.startAt) < new Date(current.startAt)) nextRaceBySet.set(entry.startggSetId, entry);
      }
      // Restreams (and their VODs) of the races already played, in race order
      const pastStreamsBySet = new Map();
      for (const entry of (tournament.midosHouse?.pastRestreams || []).slice().sort((a, b) => new Date(a.startAt) - new Date(b.startAt))) {
        if (!entry.startggSetId) continue;
        if (!pastStreamsBySet.has(entry.startggSetId)) pastStreamsBySet.set(entry.startggSetId, []);
        pastStreamsBySet.get(entry.startggSetId).push(...(entry.restreams || []));
      }
      // Events without start.gg sets on Mido's House: by the match's racetime.gg rooms
      const pastStreamsByRoom = midosHouseStreamsByRoom(tournament);
      const streamsOfRooms = m => (Array.isArray(m.raceUrls) && m.raceUrls.length ? m.raceUrls : [m.raceUrl])
        .flatMap(url => pastStreamsByRoom.get(racetimeRoomPath(url)) || []);

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
          identifier: m.phaseGroup ? `${m.phaseGroup}-R${m.round}` : `R${m.round}`,
          scheduledAt: (!m.completedAt && nextRaceBySet.get(String(m.startggSetId))?.startAt) || null,
          restreams: (m.completedAt
            ? pastStreamsBySet.get(String(m.startggSetId)) || streamsOfRooms(m)
            : nextRaceBySet.get(String(m.startggSetId))?.restreams) || []
        };
      });
      
      return res.json({ matches: formattedMatches });
    }
    
    // Challonge tournament - fetch from Match collection
    const matches = await Match.find({ tournamentId: req.params.id })
      .sort({ round: 1, completedAt: -1 })
      .lean();

    const pastStreamsByRoom = midosHouseStreamsByRoom(tournament);
    if (pastStreamsByRoom.size) {
      matches.forEach(m => { m.restreams = pastStreamsByRoom.get(racetimeRoomPath(m.raceUrl)) || []; });
    }

    res.json({ matches });
  } catch (error) {
    next(error);
  }
});

// Get tournament races
router.get('/:id/races', validateObjectId('id'), async (req, res, next) => {
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

module.exports = router;
