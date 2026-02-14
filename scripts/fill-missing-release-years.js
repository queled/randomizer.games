#!/usr/bin/env node
/**
 * Fill missing Game official.releaseYear values.
 *
 * Safe-by-default (dry-run):
 * - Only updates when source is explicit and trustworthy
 * - Skips any uncertain match
 *
 * Sources used (in order):
 * 1) Existing official.releaseDate in DB
 * 2) rando_list_cache exact lookup (only if Game is already linked with seriesFile + gameName)
 * 3) speedrun.com by explicit integrations.speedrun.gameId
 *
 * Usage:
 *   node scripts/fill-missing-release-years.js
 *   node scripts/fill-missing-release-years.js --apply
 *   node scripts/fill-missing-release-years.js --limit=100
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const connectDB = require('../config/database');
const { Game } = require('../models');
const speedrunAPI = require('../services/speedrun');

function parseArgs(argv) {
  const apply = argv.includes('--apply');
  const help = argv.includes('--help');
  const limitArg = argv.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;
  return { apply, help, limit: Number.isFinite(limit) && limit > 0 ? limit : null };
}

function yearFromDate(dateValue) {
  if (!dateValue) return null;
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  if (year < 1970 || year > 2100) return null;
  return year;
}

function yearFromSpeedrunRaw(srcGame) {
  if (!srcGame) return null;

  if (Number.isInteger(srcGame.released) && srcGame.released >= 1970 && srcGame.released <= 2100) {
    return srcGame.released;
  }

  if (srcGame['release-date']) {
    const parsed = new Date(srcGame['release-date']);
    if (!Number.isNaN(parsed.getTime())) {
      const year = parsed.getUTCFullYear();
      if (year >= 1970 && year <= 2100) return year;
    }
  }

  return null;
}

async function buildRandoListYearResolver() {
  const collections = await mongoose.connection.db.listCollections({}, { nameOnly: true }).toArray();
  const hasCache = collections.some(c => c.name === 'rando_list_cache');
  if (!hasCache) {
    return async () => ({ year: null, reason: 'cache_missing' });
  }

  const cache = mongoose.connection.collection('rando_list_cache');

  return async (game) => {
    const seriesFile = game.integrations?.randoList?.seriesFile;
    const linkedGameName = game.integrations?.randoList?.gameName;
    if (!seriesFile || !linkedGameName) {
      return { year: null, reason: 'not_linked' };
    }

    const docId = seriesFile.replace(/\.ya?ml$/i, '');
    const doc = await cache.findOne({ _id: docId }, { projection: { games: 1 } });
    if (!doc?.games?.length) {
      return { year: null, reason: 'series_not_found' };
    }

    const match = doc.games.find(g => g.name === linkedGameName);
    if (!match) {
      return { year: null, reason: 'game_not_found_in_series' };
    }

    if (Number.isInteger(match.releaseYear) && match.releaseYear >= 1970 && match.releaseYear <= 2100) {
      return { year: match.releaseYear, reason: 'rando_list_cache' };
    }

    const y = yearFromDate(match.releaseDate);
    if (y) {
      return { year: y, reason: 'rando_list_cache_date' };
    }

    return { year: null, reason: 'rando_list_no_date' };
  };
}

async function resolveYear(game, resolveRandoListYear) {
  const fromReleaseDate = yearFromDate(game.official?.releaseDate);
  if (fromReleaseDate) {
    return { year: fromReleaseDate, source: 'official.releaseDate' };
  }

  const fromRando = await resolveRandoListYear(game);
  if (fromRando.year) {
    return { year: fromRando.year, source: fromRando.reason };
  }

  const speedrunId = game.integrations?.speedrun?.gameId;
  if (speedrunId) {
    const srcGame = await speedrunAPI.getGameById(speedrunId);
    const speedrunYear = yearFromSpeedrunRaw(srcGame);
    if (speedrunYear) {
      return { year: speedrunYear, source: 'speedrun.gameId' };
    }
  }

  return { year: null, source: 'none' };
}

async function main() {
  const { apply, help, limit } = parseArgs(process.argv.slice(2));

  if (help) {
    console.log(`
Usage: node scripts/fill-missing-release-years.js [options]

Options:
  --apply        Applique les modifications en BDD
  --limit=<n>    Traite seulement <n> jeux
  --help         Affiche cette aide

Sans --apply, le script fonctionne en DRY-RUN.
`);
    process.exit(0);
  }

  const dryRun = !apply;

  console.log('🎮 Fill missing release years');
  console.log(`Mode: ${dryRun ? 'DRY-RUN' : 'APPLY'}`);
  if (limit) console.log(`Limit: ${limit}`);

  await connectDB();

  try {
    const query = {
      enabled: { $ne: false },
      $or: [
        { 'official.releaseYear': { $exists: false } },
        { 'official.releaseYear': null }
      ]
    };

    let cursor = Game.find(query, {
      id: 1,
      name: 1,
      official: 1,
      integrations: 1
    }).sort({ id: 1 });

    if (limit) cursor = cursor.limit(limit);

    const games = await cursor.lean();
    console.log(`\n📦 Jeux sans année: ${games.length}`);

    const resolveRandoListYear = await buildRandoListYearResolver();

    const stats = {
      total: games.length,
      updated: 0,
      skipped: 0,
      sources: {
        releaseDate: 0,
        randoList: 0,
        speedrun: 0
      }
    };

    for (const game of games) {
      const { year, source } = await resolveYear(game, resolveRandoListYear);

      if (!year) {
        stats.skipped++;
        continue;
      }

      const update = {
        'official.releaseYear': year
      };

      if (dryRun) {
        console.log(`📋 [DRY-RUN] ${game.id} -> ${year} (${source})`);
      } else {
        await Game.updateOne({ _id: game._id }, { $set: update });
        console.log(`✅ ${game.id} -> ${year} (${source})`);
      }

      stats.updated++;

      if (source === 'official.releaseDate') stats.sources.releaseDate++;
      else if (source.startsWith('rando_list')) stats.sources.randoList++;
      else if (source === 'speedrun.gameId') stats.sources.speedrun++;
    }

    console.log('\n' + '='.repeat(50));
    console.log(dryRun ? '📋 RÉSUMÉ (DRY-RUN)' : '📋 RÉSUMÉ');
    console.log('='.repeat(50));
    console.log(`Total traités: ${stats.total}`);
    console.log(`Mis à jour:   ${stats.updated}`);
    console.log(`Ignorés:      ${stats.skipped}`);
    console.log(`  - official.releaseDate: ${stats.sources.releaseDate}`);
    console.log(`  - rando-list cache:     ${stats.sources.randoList}`);
    console.log(`  - speedrun.com (ID):    ${stats.sources.speedrun}`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(err => {
  console.error('❌ Erreur fatale:', err.message);
  process.exit(1);
});
