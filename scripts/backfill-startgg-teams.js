#!/usr/bin/env node
/**
 * Backfill start.gg team entrants (co-op events)
 *
 * Tournaments imported before teams were stored only kept the players. This fetches the
 * entrants of each start.gg event and records the team of every player and the players
 * of every team in the matches.
 *
 * Usage:
 *   node scripts/backfill-startgg-teams.js              # every start.gg tournament
 *   node scripts/backfill-startgg-teams.js --id <mongoId>
 *   node scripts/backfill-startgg-teams.js --dry-run
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const connectDB = require('../config/database');
const { Tournament } = require('../models');
const StartGGAPI = require('../services/startgg');

const RATE_LIMIT_MS = 800;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function parseArgs() {
  const args = process.argv.slice(2);
  const idIndex = args.indexOf('--id');
  return {
    dryRun: args.includes('--dry-run'),
    id: idIndex >= 0 ? args[idIndex + 1] : null
  };
}

async function main() {
  const { dryRun, id } = parseArgs();
  if (!process.env.STARTGG_API_TOKEN) throw new Error('STARTGG_API_TOKEN manquant');
  await connectDB();

  const query = id ? { _id: id } : { startggId: { $ne: null } };
  const tournaments = await Tournament.find(query).select('name startggId participants matches').lean();
  const api = new StartGGAPI();
  let updated = 0;

  for (const tournament of tournaments) {
    if (!tournament.startggId) continue;
    await sleep(RATE_LIMIT_MS);
    let entrants;
    try {
      entrants = await api.getEventEntrants(tournament.startggId);
    } catch (error) {
      console.log(`   ⚠️  ${tournament.name}: ${error.message}`);
      continue;
    }

    const teams = StartGGAPI.teamMembersByEntrant({ entrants });
    if (!teams.size) continue;

    const teamOfPlayer = new Map();
    for (const entrant of entrants) {
      if (!teams.has(String(entrant.id))) continue;
      for (const p of entrant.participants || []) {
        teamOfPlayer.set(p.gamerTag || p.user?.name, { team: entrant.name, startggEntrantId: String(entrant.id) });
      }
    }

    const participants = (tournament.participants || []).map(p => ({ ...p, ...(teamOfPlayer.get(p.name) || {}) }));
    const withMembers = side => {
      const members = side && teams.get(String(side.startggEntrantId));
      return members ? { ...side, members } : side;
    };
    const matches = (tournament.matches || []).map(m => ({ ...m, player1: withMembers(m.player1), player2: withMembers(m.player2) }));

    console.log(`   👥 ${tournament.name}: ${teams.size} équipes, ${teamOfPlayer.size} joueurs`);
    if (!dryRun) {
      await Tournament.updateOne({ _id: tournament._id }, { $set: { participants, matches } });
    }
    updated++;
  }

  console.log(`\n✅ ${updated} tournoi(s) en équipes${dryRun ? ' (dry-run)' : ' mis à jour'}`);
  await mongoose.disconnect();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
