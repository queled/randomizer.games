#!/usr/bin/env node
/**
 * One-off migration: fills finishTimeMs on entrants that only have finishTime.
 * The past-races catch-up of sync-racetime-global.js stored raw racetime.gg
 * entrants, whose finish time is the ISO duration finish_time only, without
 * computing finishTimeMs: leaderboards, stats and time comparisons skipped them.
 *
 * Idempotent: only touches entrants with a finishTime and no finishTimeMs.
 *
 * Usage:
 *   node scripts/migrations/migrate-missing-finish-time-ms.js
 *   node scripts/migrations/migrate-missing-finish-time-ms.js --dry-run
 */

const mongoose = require('mongoose');
const connectDB = require('../../config/database');
const { Race } = require('../../models');
const { durationToMs } = require('../../services/racetime');

const isDryRun = process.argv.includes('--dry-run');

async function main() {
  await connectDB();

  const races = await Race.find({
    entrants: { $elemMatch: { finishTime: { $type: 'string', $ne: '' }, finishTimeMs: null } }
  }).select('url entrants.finishTime entrants.finishTimeMs').lean();
  console.log(`${races.length} race(s) avec des temps sans finishTimeMs${isDryRun ? ' [DRY-RUN]' : ''}`);

  const stats = { races: 0, entrants: 0, unparsed: 0 };
  for (const race of races) {
    const $set = {};
    race.entrants.forEach((entrant, i) => {
      if (!entrant.finishTime || entrant.finishTimeMs != null) return;
      const ms = durationToMs(entrant.finishTime);
      if (ms == null) {
        stats.unparsed++;
        return;
      }
      $set[`entrants.${i}.finishTimeMs`] = ms;
    });
    const count = Object.keys($set).length;
    if (!count) continue;
    stats.races++;
    stats.entrants += count;
    if (!isDryRun) await Race.updateOne({ _id: race._id }, { $set });
  }

  console.log(`Races mises à jour : ${stats.races}`);
  console.log(`Participants complétés : ${stats.entrants}`);
  console.log(`Temps illisibles : ${stats.unparsed}`);

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
