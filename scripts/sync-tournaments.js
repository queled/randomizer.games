#!/usr/bin/env node
/**
 * Sync Tournaments
 * 
 * Lightweight script for regular (automated) tournament synchronisation.
 * Re-fetches existing tournaments that are still "in progress" and discovers
 * recently-created ones since the last sync.
 * 
 * Designed to be called from cron / GitHub Actions on a regular schedule.
 * 
 * Usage:
 *   node scripts/sync-tournaments.js                     # Default: update active + discover recent
 *   node scripts/sync-tournaments.js --update-only       # Only update existing in-progress tournaments
 *   node scripts/sync-tournaments.js --discover-only     # Only discover new tournaments
 *   node scripts/sync-tournaments.js --days 7            # Discover from last N days (default: 30)
 *   node scripts/sync-tournaments.js --dry-run           # Preview only
 *   node scripts/sync-tournaments.js --challonge-hours 6 # Refresh Challonge tournaments every 6 h (default: 24)
 *
 * The Challonge plan allows 500 API requests per 30 days: a Challonge tournament is
 * refreshed once per --challonge-hours, and once a week while it awaits the organizer's
 * review (played, final ranks not published), whatever the job's own schedule.
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const connectDB = require('../config/database');
const { Game, Tournament, Match, Race } = require('../models');
const StartGGAPI = require('../services/startgg');
const challongeAPI = require('../services/challonge');
const findGameForTournament = require('../helpers/findGameForTournament');
const sanitizeHtml = require('sanitize-html');
const { saveGroupedChallongeBracket } = require('../services/challonge-bracket-groups');
const { fillMissingFinalRanks } = require('../helpers/bracket-ranks');

const RATE_LIMIT_MS = 1500;
const HOUR_MS = 60 * 60 * 1000;
// Played brackets the organizer has not finalized: often left like that for good
const AWAITING_REVIEW_HOURS = 7 * 24;

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    updateOnly: false,
    discoverOnly: false,
    days: 30,
    dryRun: false,
    challongeHours: 24
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--update-only': opts.updateOnly = true; break;
      case '--discover-only': opts.discoverOnly = true; break;
      case '--days': opts.days = parseInt(args[++i]) || 30; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--challonge-hours': opts.challongeHours = Number(args[++i]) || 24; break;
    }
  }
  return opts;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanDescription(description) {
  if (!description) return null;
  return sanitizeHtml(description, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'br']),
    allowedAttributes: {
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height']
    }
  });
}

// ─── Update existing in-progress tournaments ─────────────────────────────────

function isChallongeRefreshDue(tournament, challongeHours) {
  if (!tournament.challongeSyncedAt) return true;
  const hours = tournament.state === 'awaiting_review' ? Math.max(challongeHours, AWAITING_REVIEW_HOURS) : challongeHours;
  return Date.now() - new Date(tournament.challongeSyncedAt).getTime() >= hours * HOUR_MS;
}

async function updateActiveTournaments({ dryRun, challongeHours }) {
  const stats = { updated: 0, skipped: 0, errors: 0 };

  // Find tournaments that are still active / not completed, or played but not finalized
  // by the organizer yet (Challonge "awaiting_review": no final ranks until then)
  const activeTournaments = await Tournament.find({
    state: { $in: ['pending', 'underway', 'in_progress', 'active', '1', '2', 'ACTIVE', 'CREATED', 'awaiting_review'] }
  }).lean();

  console.log(`\n🔄 Updating ${activeTournaments.length} active tournament(s)...`);

  for (const tournament of activeTournaments) {
    const fromChallonge = !tournament.startggId && Boolean(tournament.challongeBrackets?.length || tournament.challongeId);
    if (fromChallonge && (challongeAPI.quotaExhausted || !isChallongeRefreshDue(tournament, challongeHours))) {
      stats.skipped++;
      continue;
    }

    try {
      if (tournament.startggId) {
        // Refresh from start.gg
        if (!process.env.STARTGG_API_TOKEN) { stats.skipped++; continue; }

        const slug = tournament.startggSlug;
        if (!slug) { stats.skipped++; continue; }

        const fullSlug = slug.startsWith('tournament/') ? slug : `tournament/${slug}`;

        if (dryRun) {
          console.log(`   📋 [DRY-RUN] Would update start.gg: ${tournament.name}`);
          stats.updated++;
          continue;
        }

        await sleep(RATE_LIMIT_MS);
        const api = new StartGGAPI();

        // Re-fetch the parent tournament to get updated event data
        // The startggSlug stores event slug like "tournament/xxx/event/yyy"
        // We need the parent tournament slug
        const parentSlug = slug.split('/event/')[0];
        const tSlug = parentSlug.startsWith('tournament/') ? parentSlug : `tournament/${parentSlug}`;

        const tournamentData = await api.getTournament(tSlug);
        if (!tournamentData) { stats.skipped++; continue; }

        // Find the matching event
        const event = tournamentData.events?.find(e => e.id === tournament.startggId);
        if (!event) { stats.skipped++; continue; }

        // Build updated matches from API
        const newMatches = (event.sets || []).map(set => ({
          startggSetId: set.id,
          round: set.round,
          displayScore: set.displayScore,
          completedAt: set.completedAt,
          state: set.state,
          phase: set.phase?.name || null,
          phaseGroup: set.phaseGroup?.displayIdentifier || null,
          player1: StartGGAPI.setPlayer(set.entrants?.[0]),
          player2: StartGGAPI.setPlayer(set.entrants?.[1]),
          winnerId: set.winnerId
        }));

        // Preserve existing race links (raceUrl, raceUrls, linkScore) from current DB data
        const existingLinkMap = new Map();
        if (Array.isArray(tournament.matches)) {
          for (const m of tournament.matches) {
            if (m.startggSetId && (m.raceUrl || m.raceUrls?.length || m.linkScore)) {
              existingLinkMap.set(String(m.startggSetId), {
                raceUrl: m.raceUrl || null,
                raceUrls: m.raceUrls || [],
                linkScore: m.linkScore || null
              });
            }
          }
        }

        const matches = newMatches.map(m => {
          const existing = existingLinkMap.get(String(m.startggSetId));
          if (existing) {
            return { ...m, ...existing };
          }
          return m;
        });

        const participants = StartGGAPI.buildParticipants(event);

        await Tournament.findByIdAndUpdate(tournament._id, {
          $set: {
            state: event.state?.toLowerCase?.() || String(event.state || tournament.state),
            participantsCount: event.numEntrants || participants.length,
            participants,
            matches,
            setsTotal: event.setsTotal || matches.length,
            endDate: tournamentData.endDate || tournament.endDate,
            'source.importedAt': new Date()
          },
          $currentDate: { updatedAt: true }
        });

        console.log(`   ✅ Updated: ${tournament.name} (${matches.length} matches, state: ${event.state})`);
        stats.updated++;

      } else if (tournament.challongeBrackets?.length) {
        // Several Challonge brackets stored as one tournament: refresh each of them
        if (!process.env.CHALLONGE_API_KEY) { stats.skipped++; continue; }

        if (dryRun) {
          console.log(`   📋 [DRY-RUN] Would update ${tournament.challongeBrackets.length} challonge brackets: ${tournament.name}`);
          stats.updated++;
          continue;
        }

        for (const bracket of tournament.challongeBrackets) {
          await sleep(RATE_LIMIT_MS);
          // The numeric id: the short url misses tournaments of an organization (z2r.challonge.com/sgl26)
          const challongeId = String(bracket.challongeId || bracket.url);
          const { tournamentData, participants, matches } = await challongeAPI.getTournamentDetails(challongeId);
          if (!tournamentData) continue;

          await saveGroupedChallongeBracket(
            { Tournament, Match, Race },
            { group: tournament.source?.group || tournament.name, label: bracket.label, tournamentData, participants, matches }
          );
        }
        await Tournament.updateOne({ _id: tournament._id }, { $set: { challongeSyncedAt: new Date() } });

        console.log(`   ✅ Updated: ${tournament.name} (${tournament.challongeBrackets.length} brackets)`);
        stats.updated++;

      } else if (tournament.challongeId) {
        // Refresh from Challonge
        if (!process.env.CHALLONGE_API_KEY) { stats.skipped++; continue; }

        if (dryRun) {
          console.log(`   📋 [DRY-RUN] Would update challonge: ${tournament.name}`);
          stats.updated++;
          continue;
        }

        await sleep(RATE_LIMIT_MS);
        // The numeric id: the short url misses tournaments of an organization (z2r.challonge.com/sgl26)
        const challongeId = String(tournament.challongeId || tournament.url);
        const details = await challongeAPI.getTournamentDetails(challongeId);
        const { tournamentData, matches } = details;
        if (!tournamentData) { stats.skipped++; continue; }

        // Ranks of the played bracket while the organizer has not finalized it
        const participants = fillMissingFinalRanks({ tournamentData, participants: details.participants, matches });

        await Tournament.findByIdAndUpdate(tournament._id, {
          $set: {
            state: tournamentData.state,
            participantsCount: tournamentData.participantsCount,
            participants,
            startDate: tournamentData.startedAt,
            endDate: tournamentData.completedAt,
            description: cleanDescription(tournamentData.description),
            challongeSyncedAt: new Date(),
            'source.importedAt': new Date()
          },
          $currentDate: { updatedAt: true }
        });

        // Upsert matches
        const participantMap = new Map();
        participants.forEach(p => {
          participantMap.set(p.challongeId, p);
          if (p.groupPlayerIds?.length) p.groupPlayerIds.forEach(gid => participantMap.set(gid, p));
        });

        for (const m of matches) {
          const p1 = participantMap.get(m.player1Id) || null;
          const p2 = participantMap.get(m.player2Id) || null;
          await Match.findOneAndUpdate(
            { challongeId: m.id },
            {
              $set: {
                ...m,
                tournamentId: tournament._id,
                tournamentChallongeId: tournament.challongeId,
                player1Name: p1 ? (p1.displayName || p1.name) : null,
                player2Name: p2 ? (p2.displayName || p2.name) : null
              },
              $currentDate: { updatedAt: true }
            },
            { upsert: true }
          );
        }

        console.log(`   ✅ Updated: ${tournament.name} (${matches.length} matches, state: ${tournamentData.state})`);
        stats.updated++;

      } else {
        stats.skipped++;
      }
    } catch (err) {
      if (err.code === 'CHALLONGE_QUOTA') {
        // Nothing to fix on our side: the remaining Challonge tournaments wait for the quota
        console.warn(`   ⛔ Challonge API quota exceeded: ${tournament.name} and the next Challonge tournaments are skipped`);
        stats.skipped++;
        continue;
      }
      console.error(`   ❌ Error updating ${tournament.name}: ${err.message}`);
      stats.errors++;
    }
  }

  if (challongeAPI.requestCount) console.log(`   Challonge API requests: ${challongeAPI.requestCount}`);
  return stats;
}

// ─── Discover new tournaments (delegate to discover-tournaments.js) ──────────

async function discoverNewTournaments({ days, dryRun }) {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().split('T')[0];

  console.log(`\n🔍 Discovering new tournaments since ${sinceStr}...`);

  // Rather than duplicating the full discovery logic, we use child_process
  const { execSync } = require('child_process');
  const scriptPath = path.join(__dirname, 'discover-tournaments.js');
  const cmd = `node "${scriptPath}" --since ${sinceStr} --max-pages 3${dryRun ? ' --dry-run' : ''}`;

  try {
    const output = execSync(cmd, {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
      timeout: 300000 // 5 minute timeout
    });
  } catch (err) {
    if (err.status) {
      console.warn(`   ⚠️  Discovery exited with code ${err.status}`);
    } else {
      throw err;
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║            🏆 Tournament Sync                           ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log(`  Mode:     ${opts.updateOnly ? 'update-only' : opts.discoverOnly ? 'discover-only' : 'full (update + discover)'}`);
  console.log(`  Days:     ${opts.days}`);
  console.log(`  Dry-run:  ${opts.dryRun}`);

  await connectDB();

  let totalUpdated = 0, totalSkipped = 0, totalErrors = 0;

  // Phase 1: Update active tournaments
  if (!opts.discoverOnly) {
    const updateStats = await updateActiveTournaments({ dryRun: opts.dryRun, challongeHours: opts.challongeHours });
    totalUpdated += updateStats.updated;
    totalSkipped += updateStats.skipped;
    totalErrors += updateStats.errors;
    console.log(`\n   📊 Update: ${updateStats.updated} updated, ${updateStats.skipped} skipped, ${updateStats.errors} errors`);
  }

  // Phase 2: Discover new tournaments
  if (!opts.updateOnly) {
    await discoverNewTournaments({ days: opts.days, dryRun: opts.dryRun });
  }

  // Parseable summary (used by GitHub Actions to extract stats)
  console.log('\n── RÉSUMÉ ──');
  console.log(`Mis à jour: ${totalUpdated}`);
  console.log(`Ignorés: ${totalSkipped}`);
  console.log(`Erreurs: ${totalErrors}`);

  console.log('\n✅ Tournament sync completed');
  await mongoose.disconnect();
  process.exit(totalErrors > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
