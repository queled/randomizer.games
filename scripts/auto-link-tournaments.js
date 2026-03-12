#!/usr/bin/env node
/**
 * Auto-link races already present in DB to active tournament matches.
 *
 * By default, scans active start.gg and Challonge tournaments and applies
 * confident proposals automatically.
 *
 * Usage:
 *   node scripts/auto-link-tournaments.js
 *   node scripts/auto-link-tournaments.js --dry-run
 *   node scripts/auto-link-tournaments.js <tournamentId>
 *   node scripts/auto-link-tournaments.js <tournamentId> --dry-run
 *   node scripts/auto-link-tournaments.js --all
 *   node scripts/auto-link-tournaments.js --threshold 320 --min-gap 80
 */

const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/randomizer';
const {
  buildAutoLinkPreview,
  applyAutoLinkProposals
} = require('../services/tournament-autolink');

const ACTIVE_TOURNAMENT_STATES = [
  'pending',
  'underway',
  'in_progress',
  'active',
  '1',
  '2',
  'ACTIVE',
  'CREATED'
];

function parseNumberFlag(args, flagName, fallback) {
  const index = args.indexOf(flagName);
  if (index === -1 || !args[index + 1]) return fallback;
  const parsed = Number(args[index + 1]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes('--dry-run'),
    all: args.includes('--all'),
    threshold: parseNumberFlag(args, '--threshold', 300),
    minGap: parseNumberFlag(args, '--min-gap', 50),
    tournamentId: args.find((arg) => !arg.startsWith('--')) || null
  };
}

function getTournamentSourceLabel(tournament) {
  if (tournament?.startggId) return 'start.gg';
  if (tournament?.challongeId) return 'challonge';
  return 'unknown';
}

async function main() {
  const opts = parseArgs();
  await mongoose.connect(MONGODB_URI);

  const { Tournament, Match, Race } = require('../models');

  const sourceQuery = {
    $or: [
      { startggId: { $exists: true, $ne: null } },
      { challongeId: { $exists: true, $ne: null } }
    ]
  };

  const query = opts.tournamentId
    ? { _id: opts.tournamentId, ...sourceQuery }
    : opts.all
      ? sourceQuery
      : {
          ...sourceQuery,
          state: { $in: ACTIVE_TOURNAMENT_STATES }
        };

  const tournaments = await Tournament.find(query)
    .populate('game')
    .sort({ updatedAt: -1 })
    .lean();

  if (!tournaments.length) {
    console.log('Aucun tournoi correspondant');
    console.log('\n📊 Résumé auto-link');
    console.log('Tournois: 0');
    console.log('Propositions: 0');
    console.log('Liés: 0');
    console.log('Ignorés: 0');
    console.log('Erreurs: 0');
    await mongoose.disconnect();
    return;
  }

  console.log(`🔗 Auto-link sur ${tournaments.length} tournoi(s)${opts.dryRun ? ' [DRY-RUN]' : ''}`);

  const totals = {
    tournaments: tournaments.length,
    proposed: 0,
    linked: 0,
    skipped: 0,
    errors: 0
  };

  for (const tournamentData of tournaments) {
    const sourceLabel = getTournamentSourceLabel(tournamentData);
    console.log(`\n🏁 ${tournamentData.name} [${sourceLabel}]`);

    const preview = await buildAutoLinkPreview({
      tournament: tournamentData,
      Match,
      Race,
      threshold: opts.threshold,
      minGap: opts.minGap
    });

    console.log(`   proposals=${preview.proposals.length} skipped=${preview.skipped} totalRaces=${preview.total}`);

    totals.proposed += preview.proposals.length;
    totals.skipped += preview.skipped;

    preview.proposals.forEach((proposal) => {
      const matchContext = [proposal.matchPhase, proposal.matchRound ? `R${proposal.matchRound}` : null]
        .filter(Boolean)
        .join(' / ');
      console.log(
        `   ✅ ${proposal.raceUrl} -> ${proposal.matchId} (${proposal.matchPlayers}) score=${proposal.score}${matchContext ? ` [${matchContext}]` : ''}${opts.dryRun ? ' [DRY-RUN]' : ''}`
      );
    });

    if (!preview.proposals.length || opts.dryRun) {
      continue;
    }

    const tournament = await Tournament.findById(tournamentData._id)
      .populate('game');

    if (!tournament) {
      console.log('   ⚠️  Tournoi introuvable au moment de l’application');
      totals.errors++;
      continue;
    }

    const result = await applyAutoLinkProposals({
      tournament,
      proposals: preview.proposals,
      Match,
      Race
    });

    totals.linked += result.linked;
    totals.errors += result.errors.length;

    console.log(`   🔁 linked=${result.linked}/${result.total}`);
    if (result.errors.length) {
      result.errors.forEach((error) => console.log(`   ⚠️  ${error}`));
    }
  }

  console.log('\n📊 Résumé auto-link');
  console.log(`Tournois: ${totals.tournaments}`);
  console.log(`Propositions: ${totals.proposed}`);
  console.log(`Liés: ${totals.linked}`);
  console.log(`Ignorés: ${totals.skipped}`);
  console.log(`Erreurs: ${totals.errors}`);

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
