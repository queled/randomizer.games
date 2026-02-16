#!/usr/bin/env node
/**
 * Cleanup duplicate races by canonical racetime URL.
 *
 * Strategy:
 * - Build a canonical path from race.url/source.url (e.g. /aosr/fancy-link-1234)
 * - Normalize malformed duplicated prefixes (/aosr/aosr/xxx -> /aosr/xxx)
 * - Group races by canonical path
 * - Keep the newest race in each duplicate group
 * - Delete older races in the group
 * - Preserve key linkage fields on keeper when missing
 * - Re-link Match.raceUrl from deleted URLs to kept URL when needed
 *
 * Usage:
 *   node scripts/cleanup-race-duplicates.js
 *   node scripts/cleanup-race-duplicates.js --apply
 *   node scripts/cleanup-race-duplicates.js --apply --games aos,ss
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const connectDB = require('../config/database');
const { Race, Match } = require('../models');

function parseArgs(argv) {
  const args = argv.slice(2);
  const apply = args.includes('--apply');

  const gamesIndex = args.indexOf('--games');
  const games = gamesIndex >= 0 && args[gamesIndex + 1]
    ? args[gamesIndex + 1]
        .split(',')
        .map(s => String(s || '').trim().toLowerCase())
        .filter(Boolean)
    : [];

  return { apply, games };
}

function normalizeRacePath(value, fallbackCategory) {
  if (!value) return null;
  let raw = String(value).trim();
  if (!raw) return null;

  if (/^https?:\/\//i.test(raw)) {
    try {
      raw = new URL(raw).pathname || '';
    } catch (_) {
      return null;
    }
  }

  raw = raw.split('?')[0].split('#')[0];
  raw = raw.replace(/\\/g, '/');
  raw = raw.replace(/\/+/g, '/');
  if (!raw.startsWith('/')) raw = `/${raw}`;
  raw = raw.replace(/\/+$/, '');

  if (!raw || raw === '/') return null;

  const parts = raw.split('/').filter(Boolean);
  if (parts.length === 1 && fallbackCategory) {
    raw = `/${String(fallbackCategory).toLowerCase()}/${parts[0]}`;
  }

  let normalized = raw.toLowerCase();

  while (true) {
    const match = normalized.match(/^\/([^/]+)\/\1\/(.+)$/);
    if (!match) break;
    normalized = `/${match[1]}/${match[2]}`;
  }

  return normalized;
}

function canonicalRacePath(race) {
  return (
    normalizeRacePath(race.url, race.category) ||
    normalizeRacePath(race?.source?.url, race.category)
  );
}

function raceSortDesc(a, b) {
  const aTs = new Date(a.createdAt || a.updatedAt || 0).getTime();
  const bTs = new Date(b.createdAt || b.updatedAt || 0).getTime();
  if (aTs !== bTs) return bTs - aTs;
  return String(b._id).localeCompare(String(a._id));
}

async function mergeKeeperData(keeper, duplicates) {
  const fields = [
    'matchId',
    'tournamentId',
    'tournamentPhase',
    'tournamentPool',
    'tournamentRound',
    'matchPlayers',
    'goal',
    'startedAt',
    'endedAt',
    'info'
  ];

  const setPatch = {};

  for (const field of fields) {
    if (keeper[field] != null) continue;
    const source = duplicates.find(r => r[field] != null);
    if (source) setPatch[field] = source[field];
  }

  if ((!Array.isArray(keeper.entrants) || keeper.entrants.length === 0)) {
    const withEntrants = duplicates.find(r => Array.isArray(r.entrants) && r.entrants.length > 0);
    if (withEntrants) setPatch.entrants = withEntrants.entrants;
  }

  if (Object.keys(setPatch).length === 0) return null;

  await Race.updateOne(
    { _id: keeper._id },
    { $set: setPatch, $currentDate: { updatedAt: true } }
  );

  return setPatch;
}

async function main() {
  const { apply, games } = parseArgs(process.argv);

  console.log('🧹 Cleanup race duplicates by canonical racetime URL');
  console.log(`Mode: ${apply ? 'APPLY (delete old duplicates)' : 'DRY-RUN (no changes)'}`);
  if (games.length > 0) {
    console.log(`Games filter: ${games.join(', ')}`);
  }

  await connectDB();

  const raceQuery = games.length > 0
    ? { category: { $in: games } }
    : {};

  const races = await Race.find(raceQuery)
    .select('_id category url source.url createdAt updatedAt matchId tournamentId tournamentPhase tournamentPool tournamentRound matchPlayers goal startedAt endedAt info entrants')
    .lean();

  const groups = new Map();

  for (const race of races) {
    const key = canonicalRacePath(race);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(race);
  }

  const duplicates = [...groups.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([key, list]) => ({ key, races: list.sort(raceSortDesc) }))
    .sort((a, b) => b.races.length - a.races.length);

  if (duplicates.length === 0) {
    console.log('✅ Aucun doublon détecté avec cette clé canonique.');
    return;
  }

  const byCategory = new Map();
  let totalToDelete = 0;

  for (const group of duplicates) {
    totalToDelete += group.races.length - 1;
    const category = String(group.races[0].category || 'unknown').toLowerCase();
    byCategory.set(category, (byCategory.get(category) || 0) + 1);
  }

  console.log(`Total races analyzed: ${races.length}`);
  console.log(`Duplicate groups found: ${duplicates.length}`);
  console.log(`Older races to delete: ${totalToDelete}`);

  const topCategories = [...byCategory.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);

  console.log('Top categories with duplicate groups:');
  topCategories.forEach(([cat, count]) => {
    console.log(`  - ${cat}: ${count}`);
  });

  console.log('\nSample groups (first 15):');
  duplicates.slice(0, 15).forEach((group, index) => {
    const keeper = group.races[0];
    const older = group.races.slice(1);
    console.log(`\n${index + 1}. ${group.key}`);
    console.log(`   keep:   ${keeper._id} ${keeper.url || '(no url)'} (${keeper.createdAt ? new Date(keeper.createdAt).toISOString() : 'n/a'})`);
    older.forEach(r => {
      console.log(`   delete: ${r._id} ${r.url || '(no url)'} (${r.createdAt ? new Date(r.createdAt).toISOString() : 'n/a'})`);
    });
  });

  if (!apply) {
    console.log('\nℹ️ Dry-run terminé. Relancer avec --apply pour appliquer les suppressions.');
    return;
  }

  let deletedCount = 0;
  let keeperPatchedCount = 0;
  let relinkedMatchUrls = 0;

  for (const group of duplicates) {
    const keeper = group.races[0];
    const older = group.races.slice(1);

    const patched = await mergeKeeperData(keeper, older);
    if (patched) keeperPatchedCount++;

    for (const oldRace of older) {
      if (oldRace.url && keeper.url && oldRace.url !== keeper.url) {
        const relinkResult = await Match.updateMany(
          { raceUrl: oldRace.url },
          { $set: { raceUrl: keeper.url }, $currentDate: { updatedAt: true } }
        );
        relinkedMatchUrls += relinkResult.modifiedCount || 0;
      }

      await Race.deleteOne({ _id: oldRace._id });
      deletedCount++;
    }
  }

  console.log('\n✅ Cleanup terminé.');
  console.log(`Deleted races: ${deletedCount}`);
  console.log(`Keepers patched with missing data: ${keeperPatchedCount}`);
  console.log(`Match raceUrl relinked: ${relinkedMatchUrls}`);
}

main()
  .catch(err => {
    console.error('❌ Cleanup failed:', err.message || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await mongoose.disconnect();
    } catch (_) {
      // ignore disconnect errors
    }
  });
