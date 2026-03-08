#!/usr/bin/env node
/**
 * Link start.gg tournament races to embedded tournament matches.
 *
 * This script only attempts a direct match-level link when a race clearly looks
 * like a 1v1 set (exactly 2 entrants or an explicit "A vs B" pattern).
 * Large multi-entrant rooms are intentionally left at tournament-level only.
 *
 * Usage:
 *   node scripts/link-startgg-races.js <tournamentId>
 *   node scripts/link-startgg-races.js <tournamentId> --dry-run
 *   node scripts/link-startgg-races.js --all --dry-run
 */

const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/randomizer';
const {
  rankMatchesForRace,
  selectBestCandidate,
  getMatchPlayers,
  extractRaceEntrants
} = require('../helpers/race-match-linking');

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes('--dry-run'),
    all: args.includes('--all'),
    tournamentId: args.find((arg) => !arg.startsWith('--')) || null
  };
}

async function processTournament(tournament, { Race }, dryRun) {
  const races = await Race.find({ tournamentId: tournament._id }).lean();
  const matches = Array.isArray(tournament.matches) ? tournament.matches : [];
  const stats = { linked: 0, skipped: 0, ambiguous: 0 };

  console.log(`\n🏁 ${tournament.name}`);
  console.log(`   races=${races.length} embeddedMatches=${matches.length}`);

  for (const race of races) {
    const extracted = extractRaceEntrants(race, { requireDirect: true });
    if (!extracted.direct) {
      console.log(`   ⏭️  skip ${race.url} (${extracted.entrantCount || 0} entrants, no direct pair)`);
      stats.skipped++;
      continue;
    }

    const scored = rankMatchesForRace(race, matches, {
      requireDirect: true,
      allowOccupiedMatchReassign: false
    });

    if (!scored.length) {
      console.log(`   ⚠️  no candidate for ${race.url}`);
      stats.ambiguous++;
      continue;
    }

    const chosen = selectBestCandidate(scored, {
      threshold: 320,
      minGap: 80,
      raceUrl: race.url
    });

    const top = scored[0];
    const topPlayers = getMatchPlayers(top.match);

    if (!chosen) {
      console.log(`   ⚠️  ambiguous ${race.url} top=${top.score} (${topPlayers.player1} vs ${topPlayers.player2})`);
      stats.ambiguous++;
      continue;
    }

    const chosenPlayers = getMatchPlayers(chosen.match);
    console.log(`   ✅ ${race.url} -> set ${chosen.match.startggSetId} score=${chosen.score} (${chosenPlayers.player1} vs ${chosenPlayers.player2})${dryRun ? ' [DRY-RUN]' : ''}`);

    if (!dryRun) {
      await Race.updateOne(
        { _id: race._id },
        {
          $set: {
            startggSetId: chosen.match.startggSetId,
            tournamentPhase: chosen.match.phase || race.tournamentPhase || null,
            tournamentPool: chosen.match.phaseGroup || race.tournamentPool || null,
            tournamentRound: chosen.match.round ?? race.tournamentRound ?? null,
            matchPlayers: `${chosen.match.player1?.name || ''} vs ${chosen.match.player2?.name || ''}`.trim(),
            matchConfidence: chosen.score
          },
          $currentDate: { updatedAt: true }
        }
      );

      await require('mongoose').model('Tournament').updateOne(
        { _id: tournament._id },
        {
          $set: {
            'matches.$[m].raceUrl': race.url,
            'matches.$[m].linkScore': chosen.score
          },
          $currentDate: { updatedAt: true }
        },
        {
          arrayFilters: [{ 'm.startggSetId': chosen.match.startggSetId }]
        }
      );
    }

    stats.linked++;
  }

  return stats;
}

async function main() {
  const opts = parseArgs();
  if (!opts.all && !opts.tournamentId) {
    console.error('tournamentId required, or use --all');
    process.exit(1);
  }

  await mongoose.connect(MONGODB_URI);
  const { Tournament, Race } = require('../models');

  const query = opts.all
    ? { startggId: { $exists: true, $ne: null } }
    : { _id: opts.tournamentId, startggId: { $exists: true, $ne: null } };

  const tournaments = await Tournament.find(query).lean();
  if (!tournaments.length) {
    console.log('No matching start.gg tournament found');
    await mongoose.disconnect();
    return;
  }

  const total = { linked: 0, skipped: 0, ambiguous: 0 };
  for (const tournament of tournaments) {
    const stats = await processTournament(tournament, { Race }, opts.dryRun);
    total.linked += stats.linked;
    total.skipped += stats.skipped;
    total.ambiguous += stats.ambiguous;
  }

  console.log(`\n📊 Summary: linked=${total.linked} skipped=${total.skipped} ambiguous=${total.ambiguous}${opts.dryRun ? ' [DRY-RUN]' : ''}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
