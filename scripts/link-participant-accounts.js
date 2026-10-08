#!/usr/bin/env node
/**
 * Link tournament participants to the racetime account that raced their matches
 * ("Ultimastrike" in the bracket = "Ultimaderp" on racetime), from the races linked
 * to the matches. Done after each race link; this script catches up past tournaments.
 *
 * Dry run by default: lists the participants whose account would change.
 *
 * Usage:
 *   node scripts/link-participant-accounts.js --all
 *   node scripts/link-participant-accounts.js --all --apply
 *   node scripts/link-participant-accounts.js <tournamentId> --apply
 */

const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/randomizer';
const { Tournament, Race } = require('../models');
const { syncParticipantAccounts } = require('../helpers/participant-accounts');

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    apply: args.includes('--apply'),
    all: args.includes('--all'),
    tournamentId: args.find((arg) => !arg.startsWith('--')) || null
  };
}

async function main() {
  const { apply, all, tournamentId } = parseArgs();
  if (!all && !tournamentId) {
    console.log('Usage: node scripts/link-participant-accounts.js (--all | <tournamentId>) [--apply]');
    process.exit(1);
  }

  await mongoose.connect(MONGODB_URI);
  const tournaments = await Tournament.find(tournamentId ? { _id: tournamentId } : { 'participants.0': { $exists: true } });
  console.log(`🔎 ${tournaments.length} tournoi(s) à analyser`);

  let total = 0;
  for (const tournament of tournaments) {
    const changed = await syncParticipantAccounts({ tournament, Race, dryRun: !apply });
    if (!changed.length) continue;
    console.log(`\n🏆 ${tournament.name} (${tournament._id})`);
    for (const { name, from, to } of changed) {
      console.log(`   ${name} → ${to}${from ? ` (avant : ${from})` : ''}`);
    }
    total += changed.length;
  }

  console.log(apply
    ? `\n✅ ${total} participant(s) reliés à leur compte racetime`
    : `\n🧪 Dry run : ${total} participant(s) à relier (relancer avec --apply)`);
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
