const express = require('express');
const router = express.Router();
const challongeAPI = require('../services/challonge');
const sanitizeHtml = require('sanitize-html');
const racetimeAPI = require('../services/racetime');
const { Tournament, Match, Race, Player, Game } = require('../models');
const findGameForTournament = require('../helpers/findGameForTournament');
const { rankMatchesForRace, selectBestCandidate } = require('../helpers/race-match-linking');
const { strictLimiter, validateObjectId } = require('../middleware/security');
const { requireAdmin } = require('../middleware/admin-auth');

// Sync endpoints mutate data and must stay admin-only.
router.use(requireAdmin);
router.use(strictLimiter);

function normalizeRacetimeProfileUrl(urlOrId) {
  const raw = String(urlOrId || '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw.replace(/^http:\/\//i, 'https://').replace(/\/+$/, '');
  if (raw.startsWith('/')) return ('https://racetime.gg' + raw).replace(/\/+$/, '');
  if (raw.startsWith('user/')) return ('https://racetime.gg/' + raw).replace(/\/+$/, '');
  return 'https://racetime.gg/user/' + encodeURIComponent(raw);
}

// Sync a specific tournament
router.post('/tournament/:challongeId', async (req, res, next) => {
  try {
    const { challongeId } = req.params;
    const { gameId, gameSlug } = req.body;

    // Fetch from Challonge
    const tournamentData = await challongeAPI.getTournament(challongeId);
    const participants = await challongeAPI.getParticipants(challongeId);
    const matches = await challongeAPI.getMatches(challongeId);

    // Resolve game relation (prefer request override)
    const match = await findGameForTournament({
      providedGameSlug: gameSlug,
      providedGameId: gameId || tournamentData.gameId,
      tournamentName: tournamentData.name,
      tournamentDescription: tournamentData.description
    });

    // sanitize description HTML from external source
    const cleanDescription = tournamentData.description ? sanitizeHtml(tournamentData.description, {
      allowedTags: sanitizeHtml.defaults.allowedTags.concat([ 'img', 'br' ]),
      allowedAttributes: {
        a: [ 'href', 'name', 'target', 'rel' ],
        img: [ 'src', 'alt', 'title', 'width', 'height' ]
      },
      allowedSchemesByTag: {
        a: [ 'http', 'https', 'mailto' ],
        img: [ 'http', 'https', 'data' ]
      }
    }) : null;

    const tournamentPayload = {
      name: tournamentData.name,
      challongeId: tournamentData.id,
      url: tournamentData.url,
      fullUrl: tournamentData.fullUrl,
      tournamentType: tournamentData.tournamentType,
      state: tournamentData.state,
      participantsCount: tournamentData.participantsCount,
      description: cleanDescription,
      participants: participants,
      startDate: tournamentData.startedAt,
      endDate: tournamentData.completedAt,
      gameName: tournamentData.gameName, // Save game name from Challonge
      // source metadata
      source: { type: 'challonge', externalId: tournamentData.id, url: tournamentData.fullUrl, importedAt: new Date() }
    };

    if (match) {
      tournamentPayload.game = match.gameId;
      tournamentPayload.gameSlug = match.gameSlug;
    } else if (gameId || gameSlug || tournamentData.gameId) {
      // keep legacy fields if provided but not resolved
      tournamentPayload.gameId = gameId || gameSlug || tournamentData.gameId;
    }

    // Save tournament
    const tournament = await Tournament.findOneAndUpdate(
      { challongeId: tournamentData.id },
      { $set: tournamentPayload, $currentDate: { updatedAt: true } },
      { upsert: true, new: true }
    );

    // Create a mapping for both regular participant IDs and group player IDs
    const participantMap = new Map();
    participants.forEach(p => {
      // Map regular challonge ID
      participantMap.set(p.challongeId, p);
      // Map all group player IDs if they exist
      if (p.groupPlayerIds && Array.isArray(p.groupPlayerIds)) {
        p.groupPlayerIds.forEach(groupId => {
          participantMap.set(groupId, p);
        });
      }
    });

    // Save matches with participant names (using the mapping for both regular and group IDs)
    for (const match of matches) {
      const player1 = participantMap.get(match.player1Id);
      const player2 = participantMap.get(match.player2Id);
      
      await Match.findOneAndUpdate(
        { challongeId: match.id },
        { $set: {
          ...match,
          tournamentId: tournament._id,
          tournamentChallongeId: tournament.challongeId,
          player1Name: player1 ? (player1.displayName || player1.name) : null,
          player2Name: player2 ? (player2.displayName || player2.name) : null
        }, $currentDate: { updatedAt: true } },
        { upsert: true }
      );
    }

    res.json({
      success: true,
      tournament: tournament,
      matchesCount: matches.length
    });
  } catch (error) {
    next(error);
  }
});

// Sync races for a tournament
router.post('/races/:tournamentId', validateObjectId('tournamentId'), async (req, res, next) => {
  try {
    const { tournamentId } = req.params;
    const { category, tournamentName } = req.body;

    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }

    // Search for races
    const races = await racetimeAPI.searchTournamentRaces(
      category,
      tournamentName || tournament.name
    );

    // Save races
    let savedCount = 0;
    // preload matches for this tournament to help linking
    const existingMatches = await Match.find({ tournamentId: tournament._id }).lean();
    for (const raceData of races) {
      // derive an externalId from the racetime url if possible
      let externalId = null;
      try {
        const parts = (raceData.url || '').replace(/^https?:\/\/(www\.)?racetime.gg/, '').replace(/^\/+/, '').split('/').filter(Boolean);
        if (parts.length >= 2) externalId = parts[1];
      } catch (e) { externalId = null; }

      const race = await Race.findOneAndUpdate(
        { url: raceData.url },
        { $set: {
          ...raceData,
          tournamentId: tournament._id,
          source: { type: 'racetime', externalId: externalId, url: raceData.url || null, importedAt: new Date() }
        }, $currentDate: { updatedAt: true } },
        { upsert: true, new: true }
      );

      // Update player stats
      for (const entrant of raceData.entrants) {
        if (!entrant.user?.id) continue;
        await Player.findOneAndUpdate(
          { userId: entrant.user.id },
          { $set: {
              name: entrant.user.name,
              discriminator: entrant.user.discriminator,
              racetimeUrl: normalizeRacetimeProfileUrl(entrant.user.url || entrant.user.id)
            },
            $inc: {
              'stats.totalRaces': 1,
              'stats.totalWins': entrant.place === 1 ? 1 : 0
            },
            $currentDate: { updatedAt: true }
          },
          { upsert: true }
        );
      }

      // Attempt to link this race to a Match in the tournament using a scored heuristic
      try {
        const scored = rankMatchesForRace(race, existingMatches, {
          requireDirect: true,
          allowOccupiedMatchReassign: false
        });

        const linkedCandidate = selectBestCandidate(scored, {
          threshold: 320,
          minGap: 80,
          raceUrl: race.url
        });
        const linkedMatch = linkedCandidate ? linkedCandidate.match : null;

        if (linkedMatch) {
          await Race.findByIdAndUpdate(race._id, { $set: { matchId: linkedMatch._id, previousMatchCompletedAt: linkedMatch.completedAt || null, matchConfidence: linkedCandidate.score }, $currentDate: { updatedAt: true } });
          await Match.findByIdAndUpdate(linkedMatch._id, { $set: { raceUrl: race.url, completedAt: race.endedAt || linkedMatch.completedAt }, $currentDate: { updatedAt: true } });
        }
      } catch (err) {
        console.warn('Race->Match linking error:', err.message, err.stack);
      }

      savedCount++;
    }

    res.json({
      success: true,
      racesFound: races.length,
      racesSaved: savedCount
    });
  } catch (error) {
    next(error);
  }
});

// Sync a single racetime race by category + raceId
router.post('/race', async (req, res, next) => {
  try {
    const { category, raceId, tournamentId } = req.body;
    if (!category || !raceId) return res.status(400).json({ error: 'category and raceId required' });

    const raceData = await racetimeAPI.getRace(category, raceId);
    if (!raceData) return res.status(404).json({ error: 'race not found' });

    // Optionally attach to tournament
    const tournament = tournamentId ? await Tournament.findById(tournamentId) : null;

    const race = await Race.findOneAndUpdate(
      { url: raceData.url },
      { $set: {
        ...raceData,
        tournamentId: tournament ? tournament._id : undefined
      }, $currentDate: { updatedAt: true } },
      { upsert: true, new: true }
    );

    // If tournament provided, try to link to a Match similar to bulk logic
    if (tournament) {
      const existingMatches = await Match.find({ tournamentId: tournament._id }).lean();
      const scored = rankMatchesForRace(race, existingMatches, {
        requireDirect: true,
        allowOccupiedMatchReassign: false
      });
      const linkedCandidate = selectBestCandidate(scored, {
        threshold: 320,
        minGap: 80,
        raceUrl: race.url
      });
      const linkedMatch = linkedCandidate ? linkedCandidate.match : null;

      if (linkedMatch) {
        await Race.findByIdAndUpdate(race._id, { $set: { matchId: linkedMatch._id, previousMatchCompletedAt: linkedMatch.completedAt || null, matchConfidence: linkedCandidate.score }, $currentDate: { updatedAt: true } });
        await Match.findByIdAndUpdate(linkedMatch._id, { $set: { raceUrl: race.url, completedAt: race.endedAt || linkedMatch.completedAt }, $currentDate: { updatedAt: true } });
      }
    }

    res.json({ success: true, race });
  } catch (err) {
    next(err);
  }
});

// Manual sync trigger
router.post('/all', async (req, res, next) => {
  try {
    res.json({
      message: 'Full sync started in background',
      info: 'This may take several minutes'
    });

    // Run sync in background
    setImmediate(async () => {
      try {
        console.log('🔄 Starting full sync...');
        // Add your sync logic here
        console.log('✅ Full sync completed');
      } catch (error) {
        console.error('❌ Sync error:', error);
      }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
