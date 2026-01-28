const express = require('express');
const router = express.Router();
const challongeAPI = require('../services/challonge');
const sanitizeHtml = require('sanitize-html');
const racetimeAPI = require('../services/racetime');
const { Tournament, Match, Race, Player, Game } = require('../models');
const findGameForTournament = require('../helpers/findGameForTournament');
const { strictLimiter, validateObjectId } = require('../middleware/security');

// Apply strict rate limiting to all sync endpoints (write operations)
router.use(strictLimiter);

// Utility: simple Levenshtein distance
function levenshtein(a, b){
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({length: m+1}, () => new Array(n+1));
  for (let i=0;i<=m;i++) dp[i][0]=i;
  for (let j=0;j<=n;j++) dp[0][j]=j;
  for (let i=1;i<=m;i++){
    for (let j=1;j<=n;j++){
      const cost = a[i-1] === b[j-1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+cost);
    }
  }
  return dp[m][n];
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
        await Player.findOneAndUpdate(
          { userId: entrant.user.id },
          { $set: {
              name: entrant.user.name,
              discriminator: entrant.user.discriminator,
              racetimeUrl: entrant.user.url
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
        const normalize = s => (s || '').toString().normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

        let entrants = (raceData.entrants || []).map(e => ({
          raw: e,
          name: normalize((e.user && (e.user.name || e.user.id)) || e.name || e.displayName || ''),
          finishedAt: e.finishedAt || e.finished_at || null
        }));

        // Fallback: if entrants lack names, try to parse player names from race name/info (e.g. "Xavi vs Ico")
        if (!entrants.some(en => en.name)) {
          const text = (raceData.name || '') + '\n' + (raceData.info || '');
          const vsRe = /([^\n\r:|\t\-]{1,40})\s+(?:vs|v|vs\.|:|-)\s+([^\n\r]{1,40})/i;
          const m = vsRe.exec(text);
          if (m) {
            const a = normalize(m[1]);
            const b = normalize(m[2]);
            if (a) entrants.push({ raw: null, name: a, finishedAt: null });
            if (b) entrants.push({ raw: null, name: b, finishedAt: null });
          }
        }

        const scoreNameMatch = (entrantName, target) => {
          if (!entrantName || !target) return 0;
          if (entrantName === target) return 300;
          const etoks = entrantName.split(' ').filter(Boolean);
          const ttoks = target.split(' ').filter(Boolean);
          if (etoks.includes(target)) return 200;
          if (ttoks.length && ttoks.every(t => etoks.includes(t))) return 180;
          // Prefix/suffix handling: e.g. 'ico' vs 'icola' should match strongly
          for (const et of etoks) {
            for (const tt of ttoks) {
              if (et.startsWith(tt) || tt.startsWith(et)) {
                const lenDiff = Math.abs(et.length - tt.length);
                if (lenDiff <= 3) return 220;
              }
            }
          }
          try { if ((new RegExp('\\b' + target.replace(/[.*+?^${}()|[\\]\\]/g,'\\$&') + '\\b')).test(entrantName)) return 160; } catch(e){}
          // levenshtein similarity fallback
          const lev = levenshtein(entrantName, target);
          const maxLen = Math.max(entrantName.length, target.length) || 1;
          const sim = 1 - (lev / maxLen);
          if (sim > 0.85) return 140;
          if (sim > 0.7) return 80;
          return 0;
        };

        const matchScore = (m) => {
          const p1 = normalize(m.player1Name || '');
          const p2 = normalize(m.player2Name || '');
          if (!p1 || !p2) return 0;

          // For each player, pick best entrant score
          let best1 = {score:0, entrant:null};
          let best2 = {score:0, entrant:null};
          for (const ent of entrants) {
            const s1 = scoreNameMatch(ent.name, p1);
            if (s1 > best1.score) best1 = {score: s1, entrant: ent};
            const s2 = scoreNameMatch(ent.name, p2);
            if (s2 > best2.score) best2 = {score: s2, entrant: ent};
          }

          // If both best entrants are the same person, try to find second best for the weaker side
          if (best1.entrant && best2.entrant && best1.entrant === best2.entrant) {
            // find second best for player2
            let secondBest2 = {score:0, entrant:null};
            for (const ent of entrants) {
              if (ent === best1.entrant) continue;
              const s = scoreNameMatch(ent.name, p2);
              if (s > secondBest2.score) secondBest2 = {score: s, entrant: ent};
            }
            if (secondBest2.score > 0) best2 = secondBest2;
          }

          if (!best1.entrant || !best2.entrant || best1.entrant === best2.entrant) return 0;

          let total = best1.score + best2.score;

          // Time proximity bonus: compare match finishedAt (if exists in DB) with entrants finishedAt
          try {
            const matchFinished = m.completedAt || m.startedAt || null;
            if (matchFinished) {
              const mtime = new Date(matchFinished).getTime();
              if (!isNaN(mtime)) {
                const f1 = best1.entrant.finishedAt ? new Date(best1.entrant.finishedAt).getTime() : null;
                const f2 = best2.entrant.finishedAt ? new Date(best2.entrant.finishedAt).getTime() : null;
                if (f1) {
                  const d = Math.abs(mtime - f1) / 1000;
                  if (d <= 10) total += 120; else if (d <= 60) total += 80; else if (d <= 600) total += 40; else if (d <= 86400) total += 200;
                }
                if (f2) {
                  const d = Math.abs(mtime - f2) / 1000;
                  if (d <= 10) total += 120; else if (d <= 60) total += 80; else if (d <= 600) total += 40; else if (d <= 86400) total += 200;
                }
              }
            }
          } catch (e) {}

          return total;
        };

        // score all matches and pick best
        const scored = existingMatches.map(m => ({m, score: matchScore(m)})).filter(x => x.score > 0);
        scored.sort((a,b) => b.score - a.score);

        let linkedMatch = null;
        if (scored.length) {
          // prefer first with no raceUrl among top candidates
          const topScore = scored[0].score;
          const topCandidates = scored.filter(s => s.score >= Math.max(150, topScore - 50));
          linkedMatch = topCandidates.find(c => !c.m.raceUrl) || topCandidates[0];
          linkedMatch = linkedMatch ? linkedMatch.m : null;
        }

        if (linkedMatch) {
          // store previous completedAt on the Race so we can restore if unlinked later
          await Race.findByIdAndUpdate(race._id, { $set: { matchId: linkedMatch._id, previousMatchCompletedAt: linkedMatch.completedAt || null }, $currentDate: { updatedAt: true } });
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
      const normalize = s => (s || '').toString().normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

      let entrants = (raceData.entrants || []).map(e => ({
        raw: e,
        name: normalize((e.user && (e.user.name || e.user.id)) || e.name || e.displayName || ''),
        finishedAt: e.finishedAt || e.finished_at || null
      }));

      if (!entrants.some(en => en.name)) {
        const text = (raceData.name || '') + '\n' + (raceData.info || '');
        const vsRe = /([^\n\r:|\t\-]{1,40})\s+(?:vs|v|vs\.|:|-)\s+([^\n\r]{1,40})/i;
        const m = vsRe.exec(text);
        if (m) {
          const a = normalize(m[1]);
          const b = normalize(m[2]);
          if (a) entrants.push({ raw: null, name: a, finishedAt: null });
          if (b) entrants.push({ raw: null, name: b, finishedAt: null });
        }
      }

      const scoreNameMatch = (entrantName, target) => {
        if (!entrantName || !target) return 0;
        if (entrantName === target) return 300;
        const etoks = entrantName.split(' ').filter(Boolean);
        const ttoks = target.split(' ').filter(Boolean);
        if (etoks.includes(target)) return 200;
        if (ttoks.length && ttoks.every(t => etoks.includes(t))) return 180;
        // Prefix/suffix handling: e.g. 'ico' vs 'icola' should match strongly
        for (const et of etoks) {
          for (const tt of ttoks) {
            if (et.startsWith(tt) || tt.startsWith(et)) {
              const lenDiff = Math.abs(et.length - tt.length);
              if (lenDiff <= 3) return 220;
            }
          }
        }
        try { if ((new RegExp('\b' + target.replace(/[.*+?^${}()|[\\]\\]/g,'\\$&') + '\\b')).test(entrantName)) return 160; } catch(e){}
        const lev = levenshtein(entrantName, target);
        const maxLen = Math.max(entrantName.length, target.length) || 1;
        const sim = 1 - (lev / maxLen);
        if (sim > 0.85) return 140;
        if (sim > 0.7) return 80;
        return 0;
      };

      const matchScore = (m) => {
        const p1 = normalize(m.player1Name || '');
        const p2 = normalize(m.player2Name || '');
        if (!p1 || !p2) return 0;

        let best1 = {score:0, entrant:null};
        let best2 = {score:0, entrant:null};
        for (const ent of entrants) {
          const s1 = scoreNameMatch(ent.name, p1);
          if (s1 > best1.score) best1 = {score: s1, entrant: ent};
          const s2 = scoreNameMatch(ent.name, p2);
          if (s2 > best2.score) best2 = {score: s2, entrant: ent};
        }

        if (best1.entrant && best2.entrant && best1.entrant === best2.entrant) {
          let secondBest2 = {score:0, entrant:null};
          for (const ent of entrants) {
            if (ent === best1.entrant) continue;
            const s = scoreNameMatch(ent.name, p2);
            if (s > secondBest2.score) secondBest2 = {score: s, entrant: ent};
          }
          if (secondBest2.score > 0) best2 = secondBest2;
        }

        if (!best1.entrant || !best2.entrant || best1.entrant === best2.entrant) return 0;

        let total = best1.score + best2.score;
        try {
          const matchFinished = m.completedAt || m.startedAt || null;
          if (matchFinished) {
            const mtime = new Date(matchFinished).getTime();
            if (!isNaN(mtime)) {
              const f1 = best1.entrant.finishedAt ? new Date(best1.entrant.finishedAt).getTime() : null;
              const f2 = best2.entrant.finishedAt ? new Date(best2.entrant.finishedAt).getTime() : null;
              if (f1) {
                const d = Math.abs(mtime - f1) / 1000;
                if (d <= 10) total += 120; else if (d <= 60) total += 80; else if (d <= 600) total += 40;
              }
              if (f2) {
                const d = Math.abs(mtime - f2) / 1000;
                if (d <= 10) total += 120; else if (d <= 60) total += 80; else if (d <= 600) total += 40;
              }
            }
          }
        } catch (e) {}

        return total;
      };

      const scored = existingMatches.map(m => ({m, score: matchScore(m)})).filter(x => x.score > 0);
      scored.sort((a,b) => b.score - a.score);
      const linkedMatch = (() => {
        if (!scored.length) return null;
        const topScore = scored[0].score;
        const topCandidates = scored.filter(s => s.score >= Math.max(150, topScore - 50));
        const chosen = topCandidates.find(c => !c.m.raceUrl) || topCandidates[0];
        return chosen ? chosen.m : null;
      })();

      if (linkedMatch) {
        await Race.findByIdAndUpdate(race._id, { $set: { matchId: linkedMatch._id, previousMatchCompletedAt: linkedMatch.completedAt || null }, $currentDate: { updatedAt: true } });
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
