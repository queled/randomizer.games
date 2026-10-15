#!/usr/bin/env node
/**
 * Auto-link Challonge tournament matches with racetime races.
 *
 * Usage:
 *   node scripts/link-challonge-races.js <tournamentId>
 *   node scripts/link-challonge-races.js <tournamentId> --dry-run
 *   node scripts/link-challonge-races.js --all --dry-run
 */

const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env'), quiet: true });

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/randomizer';
const {
  buildAutoLinkPreview,
  applyAutoLinkProposals
} = require('../services/tournament-autolink');

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes('--dry-run'),
    all: args.includes('--all'),
    tournamentId: args.find((arg) => !arg.startsWith('--')) || null
  };
}

async function main() {
  const opts = parseArgs();
  if (!opts.all && !opts.tournamentId) {
    console.error('tournamentId required, or use --all');
    process.exit(1);
  }

  await mongoose.connect(MONGODB_URI);
  const { Tournament, Match, Race } = require('../models');

  const query = opts.all
    ? { challongeId: { $exists: true, $ne: null } }
    : { _id: opts.tournamentId, challongeId: { $exists: true, $ne: null } };

  const tournaments = await Tournament.find(query)
    .populate('game')
    .lean();

  if (!tournaments.length) {
    console.log('No matching Challonge tournament found');
    await mongoose.disconnect();
    return;
  }

  const totals = { linked: 0, proposed: 0, skipped: 0, errors: 0 };

  for (const tournamentData of tournaments) {
    console.log(`\n🏁 ${tournamentData.name}`);
    const preview = await buildAutoLinkPreview({
      tournament: tournamentData,
      Match,
      Race,
      threshold: 320,
      minGap: 80
    });

    console.log(`   proposals=${preview.proposals.length} skipped=${preview.skipped} totalRaces=${preview.total}`);
    preview.proposals.forEach((proposal) => {
      console.log(`   ✅ ${proposal.raceUrl} -> ${proposal.matchId} (${proposal.matchPlayers}) score=${proposal.score}${opts.dryRun ? ' [DRY-RUN]' : ''}`);
    });

    totals.proposed += preview.proposals.length;
    totals.skipped += preview.skipped;

    if (!preview.proposals.length || opts.dryRun) {
      continue;
    }

    const tournament = await Tournament.findById(tournamentData._id).populate('game');
    const result = await applyAutoLinkProposals({
      tournament,
      proposals: preview.proposals,
      Match,
      Race
    });

    totals.linked += result.linked;
    totals.errors += result.errors.length;

    if (result.errors.length) {
      result.errors.forEach((error) => console.log(`   ⚠️  ${error}`));
    }
  }

  console.log(`\n📊 Summary: proposed=${totals.proposed} linked=${totals.linked} skipped=${totals.skipped} errors=${totals.errors}${opts.dryRun ? ' [DRY-RUN]' : ''}`);
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
