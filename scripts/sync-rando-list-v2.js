#!/usr/bin/env node
/**
 * Sync Rando-List
 * 
 * Synchronise les jeux depuis le repo GitHub video-game-randomizers/rando-list
 * vers la collection rando_list_cache en MongoDB (cache brut).
 * 
 * Ce script:
 * 1. Clone/pull le repo rando-list
 * 2. Parse les fichiers YAML de séries
 * 3. Stocke les données brutes dans rando_list_cache
 * 4. Optionnellement met à jour les intégrations.randoList des Games existants
 * 
 * Usage:
 *   node scripts/sync-rando-list.js                    # Sync cache uniquement
 *   node scripts/sync-rando-list.js --link-games       # Sync + liaison aux Games
 *   node scripts/sync-rando-list.js --dry-run          # Affiche sans modifier
 *   node scripts/sync-rando-list.js --export-csv       # Export CSV de debug
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const yaml = require('js-yaml');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const REPO_URL = process.env.RANDO_LIST_REPO || 'https://github.com/video-game-randomizers/rando-list.git';
const BRANCH = process.env.RANDO_LIST_BRANCH || 'main';
const TMP_DIR = process.env.RANDO_LIST_DIR || path.join(__dirname, 'tmp', 'rando-list');
const SERIES_DIR = path.join(TMP_DIR, 'src', 'series');

const connectDB = require('../config/database');
const { Game } = require('../models');

/**
 * Clone ou met à jour le repo
 */
function syncRepo() {
  console.log('📥 Synchronisation du repo rando-list...');
  
  if (fs.existsSync(path.join(TMP_DIR, '.git'))) {
    // Pull si déjà cloné
    console.log('  → git pull');
    execSync(`git -C "${TMP_DIR}" fetch origin ${BRANCH}`, { stdio: 'pipe' });
    execSync(`git -C "${TMP_DIR}" reset --hard origin/${BRANCH}`, { stdio: 'pipe' });
  } else {
    // Clone initial
    console.log('  → git clone');
    fs.mkdirSync(path.dirname(TMP_DIR), { recursive: true });
    execSync(`git clone --depth 1 --branch ${BRANCH} "${REPO_URL}" "${TMP_DIR}"`, { stdio: 'pipe' });
  }
  
  // Récupérer le dernier commit
  const commitHash = execSync(`git -C "${TMP_DIR}" rev-parse HEAD`, { encoding: 'utf8' }).trim();
  console.log(`  ✓ Commit: ${commitHash.slice(0, 8)}`);
  
  return commitHash;
}

/**
 * Parse tous les fichiers YAML de séries
 */
function parseSeriesFiles() {
  const seriesFiles = fs.readdirSync(SERIES_DIR)
    .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
  
  console.log(`\n📂 ${seriesFiles.length} fichiers de séries trouvés`);
  
  const allData = [];
  
  for (const file of seriesFiles) {
    try {
      const filePath = path.join(SERIES_DIR, file);
      const content = fs.readFileSync(filePath, 'utf8');
      const data = yaml.load(content);
      
      if (!data || !data.games || !data.randomizers) {
        console.log(`  ⚠️  ${file} - structure invalide, ignoré`);
        continue;
      }
      
      // Parser les jeux
      const games = [];
      for (const [gameName, gameData] of Object.entries(data.games)) {
        games.push({
          name: gameName,
          genres: gameData.genres || [],
          platforms: gameData.platforms || [],
          releaseDate: gameData['release-date'] || null,
          subSeries: gameData['sub-series'] || null,
          comment: gameData.comment || null
        });
      }
      
      // Parser les randomizers
      const randomizers = data.randomizers.map(r => ({
        games: r.games || [],
        identifier: r.identifier,
        url: r.url,
        multiworld: r.multiworld || null,
        opensource: r.opensource || false,
        obsolete: r.obsolete || false,
        comment: r.comment || null,
        addedDate: r['added-date'] || null,
        updatedDate: r['updated-date'] || null
      }));
      
      allData.push({
        seriesFile: file,
        seriesName: data.name,
        subSeries: data['sub-series'] || [],
        comment: data.comment || null,
        games,
        randomizers,
        _parsedAt: new Date()
      });
      
      console.log(`  ✓ ${file}: ${games.length} jeux, ${randomizers.length} randomizers`);
      
    } catch (error) {
      console.error(`  ❌ ${file}: ${error.message}`);
    }
  }
  
  return allData;
}

/**
 * Sauvegarde les données dans la collection cache
 */
async function saveToCacheCollection(seriesData, commitHash) {
  const colName = 'rando_list_cache';
  const col = mongoose.connection.collection(colName);
  
  // Créer un document de métadonnées
  const metadata = {
    _id: '_metadata',
    lastSync: new Date(),
    commitHash,
    seriesCount: seriesData.length,
    totalGames: seriesData.reduce((sum, s) => sum + s.games.length, 0),
    totalRandomizers: seriesData.reduce((sum, s) => sum + s.randomizers.length, 0)
  };
  
  // Bulk upsert
  const bulk = [
    { updateOne: { filter: { _id: '_metadata' }, update: { $set: metadata }, upsert: true } }
  ];
  
  for (const series of seriesData) {
    const id = series.seriesFile.replace(/\.ya?ml$/, '');
    bulk.push({
      updateOne: {
        filter: { _id: id },
        update: { $set: { ...series, _id: id } },
        upsert: true
      }
    });
  }
  
  const result = await col.bulkWrite(bulk, { ordered: false });
  console.log(`\n💾 Cache mis à jour: ${result.upsertedCount} créés, ${result.modifiedCount} modifiés`);
  
  return metadata;
}

/**
 * Tente de lier les Games existants avec les données rando-list
 */
async function linkGamesToRandoList(seriesData, dryRun = true) {
  console.log('\n🔗 Liaison des jeux existants...');
  
  const games = await Game.find({ enabled: { $ne: false } });
  console.log(`  ${games.length} jeux en BDD`);
  
  // Construire un index de tous les randomizers par nom de jeu
  const randomizerIndex = new Map();
  for (const series of seriesData) {
    for (const rando of series.randomizers) {
      if (rando.obsolete) continue; // Ignorer les obsolètes
      
      for (const gameName of rando.games) {
        const key = normalizeGameName(gameName);
        if (!randomizerIndex.has(key)) {
          randomizerIndex.set(key, []);
        }
        randomizerIndex.get(key).push({
          seriesFile: series.seriesFile,
          seriesName: series.seriesName,
          gameName,
          randomizer: rando
        });
      }
    }
  }
  
  const stats = { linked: 0, notFound: 0, alreadyLinked: 0 };
  
  for (const game of games) {
    // Skip si déjà lié manuellement
    if (game.integrations?.randoList?.confidence === 'manual') {
      stats.alreadyLinked++;
      continue;
    }
    
    // Chercher un match
    const candidates = findRandoListMatches(game, randomizerIndex);
    
    if (candidates.length === 0) {
      console.log(`  ⚠️  ${game.id} - aucun match trouvé`);
      stats.notFound++;
      continue;
    }
    
    const best = candidates[0];
    
    const updates = {
      'integrations.randoList.enabled': true,
      'integrations.randoList.seriesFile': best.seriesFile,
      'integrations.randoList.gameName': best.gameName,
      'integrations.randoList.randomizerIdentifier': best.randomizer.identifier,
      'integrations.randoList.confidence': 'auto',
      'integrations.randoList.lastSync': new Date()
    };
    
    if (dryRun) {
      console.log(`  📋 [DRY-RUN] ${game.id} → ${best.randomizer.identifier} (${best.seriesName})`);
    } else {
      await Game.updateOne({ id: game.id }, { $set: updates });
      console.log(`  ✓ ${game.id} → ${best.randomizer.identifier}`);
    }
    stats.linked++;
  }
  
  console.log(`\n  Liés: ${stats.linked}, Non trouvés: ${stats.notFound}, Déjà liés: ${stats.alreadyLinked}`);
  return stats;
}

function normalizeGameName(name) {
  return name.toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/thelegendofzelda/g, 'zelda')
    .replace(/supermetroid/g, 'sm')
    .replace(/randomizer/g, '');
}

function findRandoListMatches(game, randomizerIndex) {
  const candidates = [];
  
  // Essayer plusieurs variantes du nom
  const namesToTry = [
    game.name,
    game.official?.name,
    game.randomizer?.name,
    game.randomizer?.shortName
  ].filter(Boolean);
  
  for (const name of namesToTry) {
    const normalized = normalizeGameName(name);
    
    // Match exact
    if (randomizerIndex.has(normalized)) {
      candidates.push(...randomizerIndex.get(normalized));
    }
    
    // Match partiel
    for (const [key, matches] of randomizerIndex) {
      if (key.includes(normalized) || normalized.includes(key)) {
        candidates.push(...matches);
      }
    }
  }
  
  // Dédupliquer par identifier
  const seen = new Set();
  return candidates.filter(c => {
    const key = c.randomizer.identifier;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Export CSV pour debug
 */
async function exportToCSV(seriesData, outputPath) {
  const { createObjectCsvWriter } = require('csv-writer');
  
  const rows = [];
  for (const series of seriesData) {
    for (const rando of series.randomizers) {
      for (const gameName of rando.games) {
        rows.push({
          series: series.seriesName,
          seriesFile: series.seriesFile,
          gameName,
          randomizerIdentifier: rando.identifier,
          randomizerUrl: rando.url,
          opensource: rando.opensource,
          obsolete: rando.obsolete,
          multiworld: rando.multiworld || ''
        });
      }
    }
  }
  
  const csvWriter = createObjectCsvWriter({
    path: outputPath,
    header: Object.keys(rows[0] || {}).map(k => ({ id: k, title: k }))
  });
  
  await csvWriter.writeRecords(rows);
  console.log(`\n📄 CSV exporté: ${outputPath} (${rows.length} lignes)`);
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--help')) {
    console.log(`
Usage: node sync-rando-list.js [options]

Options:
  --link-games   Lier automatiquement les Games existants
  --dry-run      Mode simulation (avec --link-games)
  --export-csv   Exporter un CSV de debug
  --help         Affiche cette aide
`);
    process.exit(0);
  }
  
  const linkGames = args.includes('--link-games');
  const dryRun = args.includes('--dry-run');
  const exportCsv = args.includes('--export-csv');
  
  console.log('🔄 Sync Rando-List\n');
  
  try {
    // 1. Sync repo
    const commitHash = syncRepo();
    
    // 2. Parser les fichiers
    const seriesData = parseSeriesFiles();
    
    if (seriesData.length === 0) {
      console.log('\n⚠️  Aucune donnée parsée');
      process.exit(1);
    }
    
    // 3. Connexion MongoDB
    await connectDB();
    
    // 4. Sauvegarder dans le cache
    await saveToCacheCollection(seriesData, commitHash);
    
    // 5. Liaison optionnelle
    if (linkGames) {
      await linkGamesToRandoList(seriesData, dryRun);
    }
    
    // 6. Export CSV optionnel
    if (exportCsv) {
      const csvPath = path.join(__dirname, 'rando-list-export.csv');
      await exportToCSV(seriesData, csvPath);
    }
    
    console.log('\n✅ Sync terminé avec succès');
    
  } catch (error) {
    console.error('\n❌ Erreur:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

main();
