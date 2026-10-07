#!/usr/bin/env node
/**
 * Attach qualifier races (big rooms played before the bracket) to their tournament.
 *
 * Dry run by default: lists what would be attached. A race several tournaments
 * could take goes to the one its label names, then to the one whose name adds
 * nothing to the label (the main event rather than its Challenge Cup); the
 * others are left aside.
 *
 * Usage:
 *   node scripts/link-qualifier-races.js --all
 *   node scripts/link-qualifier-races.js --all --apply
 *   node scripts/link-qualifier-races.js <tournamentId> --racetime --apply
 *
 *   --racetime  also look on racetime.gg for the qualifiers missing from the database
 *               (about a minute per tournament, imported on --apply); with --all, only
 *               for the tournaments that already have qualifiers in the database
 */

const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/randomizer';
const {
  buildQualifierPreview,
  applyQualifiers
} = require('../services/tournament-qualifiers');

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    apply: args.includes('--apply'),
    all: args.includes('--all'),
    racetime: args.includes('--racetime'),
    tournamentId: args.find((arg) => !arg.startsWith('--')) || null
  };
}

const MATCH_RANK = { named: 2, bare: 1 };

// raceUrl → tournament that takes it, or null when several tournaments claim it alike
function assignRaces(previews) {
  const claims = new Map();
  for (const { tournament, proposals } of previews) {
    for (const proposal of proposals) {
      if (!claims.has(proposal.raceUrl)) claims.set(proposal.raceUrl, []);
      claims.get(proposal.raceUrl).push({ tournament, proposal });
    }
  }

  const assigned = new Map();
  for (const [raceUrl, list] of claims) {
    const best = Math.max(...list.map(({ proposal }) => MATCH_RANK[proposal.matchType]));
    let winners = list.filter(({ proposal }) => MATCH_RANK[proposal.matchType] === best);
    if (winners.length > 1) winners = winners.filter(({ proposal }) => proposal.extraNameTokens === 0);
    assigned.set(raceUrl, winners.length === 1 ? winners[0].tournament : null);
  }
  return { assigned, claims };
}

async function main() {
  const opts = parseArgs();
  if (!opts.tournamentId && !opts.all) {
    console.log('Usage: node scripts/link-qualifier-races.js (<tournamentId> | --all) [--racetime] [--apply]');
    process.exit(1);
  }

  await mongoose.connect(MONGODB_URI);
  const { Tournament, Race, Player } = require('../models');

  const tournaments = await Tournament.find(opts.tournamentId ? { _id: opts.tournamentId } : { startDate: { $ne: null } })
    .populate('game')
    .sort({ startDate: 1 });
  console.log(`🔎 ${tournaments.length} tournoi(s) à analyser${opts.racetime ? ' (avec racetime.gg)' : ''}`);

  const previews = [];
  for (const tournament of tournaments) {
    let preview = await buildQualifierPreview({ tournament: tournament.toObject(), Race });
    const hasQualifiers = preview.proposals.length > 0 || preview.alreadyAttached > 0;
    if (opts.racetime && (hasQualifiers || opts.tournamentId)) {
      console.log(`   racetime.gg : ${tournament.name}...`);
      try {
        preview = await buildQualifierPreview({ tournament: tournament.toObject(), Race, racetime: true });
      } catch (error) {
        console.log(`   ⚠️  racetime.gg indisponible (${error.message}), base seule`);
      }
    }
    if (preview.proposals.length) previews.push({ tournament, proposals: preview.proposals });
  }

  const { assigned, claims } = assignRaces(previews);
  let total = 0;

  for (const { tournament, proposals } of previews) {
    const raceUrls = proposals
      .filter((proposal) => assigned.get(proposal.raceUrl) === tournament)
      .map((proposal) => proposal.raceUrl);
    if (!raceUrls.length) continue;

    console.log(`\n🏆 ${tournament.name} (${tournament._id})`);
    for (const proposal of proposals.filter((p) => raceUrls.includes(p.raceUrl))) {
      const date = proposal.startedAt ? new Date(proposal.startedAt).toISOString().slice(0, 10) : '????-??-??';
      const flags = [proposal.matchType, proposal.inDatabase ? null : 'à importer'].filter(Boolean).join(', ');
      console.log(`   ${date} ${proposal.raceUrl} [${proposal.raceLabel.slice(0, 70)}] (${flags})`);
    }

    total += raceUrls.length;
    if (opts.apply) {
      const result = await applyQualifiers({ tournament, raceUrls, Race, Player });
      console.log(`   ✅ ${result.attached}/${result.total} ajoutée(s), ${result.imported} importée(s)`);
      for (const error of result.errors) console.log(`   ⚠️  ${error}`);
    }
  }

  const ambiguous = [...assigned].filter(([, tournament]) => !tournament);
  if (ambiguous.length) {
    console.log(`\n❔ ${ambiguous.length} race(s) réclamée(s) par plusieurs tournois, laissée(s) de côté :`);
    for (const [raceUrl] of ambiguous) {
      console.log(`   ${raceUrl} → ${claims.get(raceUrl).map(({ tournament }) => tournament.name).join(' | ')}`);
    }
  }

  console.log(`\n${opts.apply ? '✅' : '🧪 Dry run :'} ${total} qualification(s)${opts.apply ? ' ajoutée(s)' : ' à ajouter (relancer avec --apply)'}`);
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error('❌', error);
  await mongoose.disconnect();
  process.exit(1);
});
