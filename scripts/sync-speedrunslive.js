#!/usr/bin/env node
/**
 * Sync SpeedRunsLive
 *
 * Importe l'historique des courses randomizer de speedrunslive.com (SRL),
 * la plateforme utilisée avant racetime.gg. Chaque catégorie SRL est rangée
 * dans la catégorie racetime du même jeu (voir SRL_GAME_MAPPINGS).
 *
 * Les courses sont enregistrées avec l'URL /srl/<raceId>. Une course SRL
 * qui a aussi eu lieu sur racetime.gg (mêmes joueurs, même jour) est ignorée.
 *
 * Usage:
 *   node scripts/sync-speedrunslive.js --all
 *   node scripts/sync-speedrunslive.js --game oothacks
 *   node scripts/sync-speedrunslive.js --game ootr --dry-run
 *   node scripts/sync-speedrunslive.js --all --max-pages 2
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const connectDB = require('../config/database');
const { Race } = require('../models');
const srlAPI = require('../services/speedrunslive');
const { SRL_GAME_MAPPINGS, isRandomizerRace, formatRace } = require('../services/speedrunslive');

const RATE_LIMIT_MS = parseInt(process.env.SRL_RATE_LIMIT_MS) || 1000;
const PAGE_SIZE = 500;
// A race played on both platforms has the same players within a few hours
const DUPLICATE_WINDOW_MS = 12 * 60 * 60 * 1000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function entrantsKey(entrants) {
  return (entrants || []).map(e => normalizeName(e.userName)).filter(Boolean).sort().join('|');
}

async function fetchAllRaces(game, maxPages) {
  const races = [];
  let page = 1;
  let totalPages = 1;

  while (page <= Math.min(totalPages, maxPages)) {
    await sleep(RATE_LIMIT_MS);
    const result = await srlAPI.getPastResults(game, page, PAGE_SIZE);
    if (!result.races.length) break;
    races.push(...result.races);
    totalPages = result.totalPages;
    process.stdout.write(`\r  Page ${page}/${totalPages} - ${races.length} courses`);
    page++;
  }
  process.stdout.write('\n');
  return races;
}

// Index racetime races of the category by players, to skip SRL copies of them
async function loadRacetimeIndex(category, docs) {
  const index = new Map();
  if (!docs.length) return index;

  const times = docs.map(d => d.endedAt.getTime());
  const racetimeRaces = await Race.find({
    category,
    url: { $not: /^\/srl\// },
    startedAt: {
      $gte: new Date(Math.min(...times) - DUPLICATE_WINDOW_MS),
      $lte: new Date(Math.max(...times) + DUPLICATE_WINDOW_MS)
    }
  }).select('url startedAt entrants.userName').lean();

  for (const race of racetimeRaces) {
    const key = entrantsKey(race.entrants);
    if (!key || !race.startedAt) continue;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(race);
  }
  return index;
}

function findRacetimeDuplicate(index, doc) {
  const candidates = index.get(entrantsKey(doc.entrants)) || [];
  return candidates.find(race =>
    Math.abs(new Date(race.startedAt).getTime() - doc.startedAt.getTime()) <= DUPLICATE_WINDOW_MS
  ) || null;
}

async function syncMapping(mapping, { dryRun, maxPages }) {
  console.log(`\n🎮 ${mapping.srl} → ${mapping.category}`);
  const stats = { fetched: 0, randomizer: 0, duplicates: 0, newRaces: 0, updatedRaces: 0, errors: 0 };

  let rawRaces;
  try {
    rawRaces = await fetchAllRaces(mapping.srl, maxPages);
  } catch (err) {
    console.error(`  ❌ Erreur API: ${err.message}`);
    stats.errors++;
    return stats;
  }
  stats.fetched = rawRaces.length;

  const docs = rawRaces
    .filter(race => isRandomizerRace(race, mapping))
    .map(race => formatRace(race, mapping.category));
  stats.randomizer = docs.length;

  const racetimeIndex = await loadRacetimeIndex(mapping.category, docs);

  for (const doc of docs) {
    const duplicate = doc.entrants.length >= 2 ? findRacetimeDuplicate(racetimeIndex, doc) : null;
    if (duplicate) {
      stats.duplicates++;
      if (dryRun) console.log(`  ↔️  ${doc.url} déjà sur racetime: ${duplicate.url}`);
      continue;
    }

    if (dryRun) {
      stats.newRaces++;
      continue;
    }

    try {
      const { source, ...fields } = doc;
      const updateResult = await Race.updateOne(
        { url: doc.url },
        {
          $set: { ...fields, 'source.type': source.type, 'source.externalId': source.externalId, 'source.url': source.url },
          $setOnInsert: { 'source.importedAt': source.importedAt }
        },
        { upsert: true }
      );
      if (updateResult.upsertedCount > 0) stats.newRaces++;
      else if (updateResult.modifiedCount > 0) stats.updatedRaces++;
    } catch (err) {
      console.error(`  ❌ ${doc.url}: ${err.message}`);
      stats.errors++;
    }
  }

  console.log(`  ${stats.fetched} courses SRL, ${stats.randomizer} randomizer, ${stats.duplicates} déjà sur racetime`);
  console.log(`  ✓ ${stats.newRaces} ${dryRun ? 'à importer' : 'nouvelles'}, ${stats.updatedRaces} mises à jour, ${stats.errors} erreurs`);
  return stats;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const valueOf = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
  return {
    all: args.includes('--all'),
    game: valueOf('--game'),
    dryRun: args.includes('--dry-run'),
    maxPages: parseInt(valueOf('--max-pages')) || Infinity
  };
}

async function main() {
  const opts = parseArgs();

  // --game accepts an SRL abbreviation (oothacks) or a racetime category (ootr)
  const mappings = opts.all
    ? SRL_GAME_MAPPINGS
    : SRL_GAME_MAPPINGS.filter(m => opts.game && [m.srl.toLowerCase(), m.category].includes(opts.game.toLowerCase()));

  if (!mappings.length) {
    console.log('Usage: node scripts/sync-speedrunslive.js --all | --game <srl_game|racetime_category> [--dry-run] [--max-pages n]');
    console.log(`Jeux SRL connus: ${SRL_GAME_MAPPINGS.map(m => m.srl).join(', ')}`);
    process.exit(1);
  }

  console.log(`📡 SpeedRunsLive: ${mappings.length} catégorie(s)${opts.dryRun ? ' [DRY-RUN]' : ''}`);

  const totals = { fetched: 0, randomizer: 0, duplicates: 0, newRaces: 0, updatedRaces: 0, errors: 0 };
  try {
    await connectDB();
    for (const mapping of mappings) {
      const stats = await syncMapping(mapping, opts);
      for (const key of Object.keys(totals)) totals[key] += stats[key];
    }
  } catch (error) {
    console.error('Erreur:', error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }

  console.log('\n📊 Résumé SpeedRunsLive');
  console.log(`Courses SRL: ${totals.fetched}`);
  console.log(`Randomizer: ${totals.randomizer}`);
  console.log(`Déjà sur racetime: ${totals.duplicates}`);
  console.log(`${opts.dryRun ? 'À importer' : 'Nouvelles'}: ${totals.newRaces}`);
  console.log(`Mises à jour: ${totals.updatedRaces}`);
  console.log(`Erreurs: ${totals.errors}`);
}

main();
