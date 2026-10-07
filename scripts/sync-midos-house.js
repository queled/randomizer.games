#!/usr/bin/env node
/**
 * Sync Mido's House schedules
 *
 * Reads the upcoming races of the events listed on https://midos.house
 * (OoTR tournaments) and stores their start time and restreams on the
 * start.gg tournament they belong to (`tournament.midosHouse.schedule`),
 * linked to matches by start.gg set ID. Races already played drop out of
 * the list on the next sync.
 *
 * Events without start.gg sets (Challonge, league, manual brackets) are skipped.
 *
 * Usage:
 *   node scripts/sync-midos-house.js
 *   node scripts/sync-midos-house.js --dry-run
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const connectDB = require('../config/database');
const { Tournament } = require('../models');
const midosHouse = require('../services/midos-house');

const REQUEST_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) console.log('📋 Mode DRY-RUN : rien n’est écrit en base');

  await connectDB();

  const events = await midosHouse.listCurrentEvents();
  console.log(`\n🏠 ${events.length} événement(s) sur Mido's House`);

  const stats = { linked: 0, scheduled: 0, cleared: 0, noStartgg: 0, notFound: 0, errors: 0 };
  const syncedIds = [];
  const failedEvents = [];

  for (const ev of events) {
    const label = `${ev.series}/${ev.event}`;
    let races;
    try {
      await sleep(REQUEST_DELAY_MS);
      races = await midosHouse.getUpcomingRaces(ev.series, ev.event);
    } catch (error) {
      console.log(`   ❌ ${label} : ${error.message}`);
      failedEvents.push(ev);
      stats.errors++;
      continue;
    }

    // One Mido's House event can map to several start.gg events (e.g. one per bracket)
    const bySlug = new Map();
    for (const race of races) {
      if (!race.startggSlug) continue;
      if (!bySlug.has(race.startggSlug)) bySlug.set(race.startggSlug, []);
      bySlug.get(race.startggSlug).push(race);
    }
    if (!bySlug.size) {
      console.log(`   ⏭️  ${label} : pas de sets start.gg`);
      stats.noStartgg++;
      continue;
    }

    for (const [slug, slugRaces] of bySlug) {
      const tournament = await Tournament.findOne({
        startggSlug: { $in: [slug, slug.replace(/^tournament\//, '')] }
      }).select('_id name').lean();
      if (!tournament) {
        console.log(`   ⚠️  ${label} : aucun tournoi en base pour ${slug}`);
        stats.notFound++;
        continue;
      }

      const schedule = slugRaces
        .filter(r => r.startAt)
        .map(r => ({
          startggSetId: r.startggSetId,
          startAt: r.startAt,
          round: r.round,
          entrants: r.entrants,
          roomUrl: r.roomUrl,
          restreams: r.restreams
        }));
      const restreamCount = schedule.reduce((n, r) => n + r.restreams.length, 0);
      console.log(`   ✅ ${label} → ${tournament.name} : ${schedule.length} race(s) planifiée(s), ${restreamCount} restream(s)`);

      syncedIds.push(tournament._id);
      stats.linked++;
      stats.scheduled += schedule.length;
      if (dryRun) continue;

      await Tournament.updateOne({ _id: tournament._id }, {
        $set: {
          midosHouse: {
            series: ev.series,
            event: ev.event,
            url: ev.url,
            lastSync: new Date(),
            schedule
          }
        }
      });
    }
  }

  // Events gone from the home page are over: their schedule is emptied.
  // Events that failed to load this time are left as they were.
  const staleQuery = {
    _id: { $nin: syncedIds },
    'midosHouse.schedule.0': { $exists: true }
  };
  if (failedEvents.length) {
    staleQuery.$nor = failedEvents.map(ev => ({ 'midosHouse.series': ev.series, 'midosHouse.event': ev.event }));
  }
  const stale = await Tournament.find(staleQuery).select('_id name').lean();
  for (const tournament of stale) {
    console.log(`   🧹 ${tournament.name} : plus rien de planifié`);
    stats.cleared++;
    if (!dryRun) {
      await Tournament.updateOne({ _id: tournament._id }, {
        $set: { 'midosHouse.schedule': [], 'midosHouse.lastSync': new Date() }
      });
    }
  }

  console.log('\n📊 Résumé Mido\'s House');
  console.log(`Tournois reliés : ${stats.linked}`);
  console.log(`Races planifiées : ${stats.scheduled}`);
  console.log(`Tournois vidés : ${stats.cleared}`);
  console.log(`Événements sans start.gg : ${stats.noStartgg}`);
  console.log(`Tournois absents de la base : ${stats.notFound}`);
  console.log(`Erreurs : ${stats.errors}`);

  await mongoose.disconnect();
  if (stats.errors) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
