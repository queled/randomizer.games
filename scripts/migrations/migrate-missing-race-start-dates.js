#!/usr/bin/env node
/**
 * One-off migration: fills startedAt on finished races imported while still open.
 * The finalize step of sync-racetime-global.js used to update endedAt only, leaving
 * those races without a start date (hidden from date-windowed queries such as auto-link).
 *
 * Idempotent: only touches finished races whose startedAt is null.
 *
 * Usage:
 *   node scripts/migrations/migrate-missing-race-start-dates.js
 *   node scripts/migrations/migrate-missing-race-start-dates.js --dry-run
 */

const mongoose = require('mongoose');
const connectDB = require('../../config/database');
const { Race } = require('../../models');
const racetimeAPI = require('../../services/racetime');

const isDryRun = process.argv.includes('--dry-run');
const RATE_LIMIT_MS = parseInt(process.env.RACETIME_RATE_LIMIT_MS) || 500;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  await connectDB();

  const races = await Race.find({ startedAt: null, status: 'finished' })
    .select('url')
    .lean();
  console.log(`${races.length} race(s) sans date de départ${isDryRun ? ' [DRY-RUN]' : ''}`);

  const stats = { updated: 0, missing: 0, errors: 0 };
  for (const race of races) {
    const [category, raceId] = race.url.split('/').filter(Boolean);
    if (!category || !raceId) continue;

    try {
      await sleep(RATE_LIMIT_MS);
      const detail = await racetimeAPI.getRace(category, raceId);
      if (!detail?.startedAt) {
        stats.missing++;
        continue;
      }
      if (!isDryRun) {
        await Race.updateOne({ _id: race._id }, { $set: { startedAt: detail.startedAt } });
      }
      stats.updated++;
    } catch (error) {
      stats.errors++;
    }
  }

  console.log(`✓ ${stats.updated} mises à jour, ${stats.missing} sans date sur racetime, ${stats.errors} erreur(s)`);
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
