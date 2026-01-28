#!/usr/bin/env node
/**
 * Sync Rando-List V3
 * 
 * Version améliorée du script de synchronisation avec rando-list.
 * Gère les ressources (sites, trackers) et la détection de nouveaux jeux.
 * 
 * Ce script:
 * 1. Clone/pull le repo rando-list
 * 2. Parse les fichiers YAML de séries
 * 3. Stocke les données brutes dans rando_list_cache
 * 4. Met à jour les ressources (sites) des Games existants
 * 5. Détecte les nouveaux randomizers
 * 
 * Usage:
 *   node scripts/sync-rando-list-v3.js                    # Sync cache + ressources
 *   node scripts/sync-rando-list-v3.js --link-games       # Sync + liaison aux Games
 *   node scripts/sync-rando-list-v3.js --update-resources # Met à jour les ressources uniquement
 *   node scripts/sync-rando-list-v3.js --dry-run          # Affiche sans modifier
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
    console.log('  → git pull');
    execSync(`git -C "${TMP_DIR}" fetch origin ${BRANCH}`, { stdio: 'pipe' });
    execSync(`git -C "${TMP_DIR}" reset --hard origin/${BRANCH}`, { stdio: 'pipe' });
  } else {
    console.log('  → git clone');
    fs.mkdirSync(path.dirname(TMP_DIR), { recursive: true });
    execSync(`git clone --depth 1 --branch ${BRANCH} "${REPO_URL}" "${TMP_DIR}"`, { stdio: 'pipe' });
  }
  
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
          releaseYear: gameData['release-date'] ? new Date(gameData['release-date']).getFullYear() : null,
          subSeries: gameData['sub-series'] || null,
          comment: gameData.comment || null
        });
      }
      
      // Parser les randomizers avec détection Archipelago
      const randomizers = data.randomizers.map(r => {
        const url = r.url || '';
        const isArchipelago = url.toLowerCase().includes('archipelago');
        
        return {
          games: r.games || [],
          identifier: r.identifier,
          url: url,
          name: r.name || null,
          multiworld: r.multiworld || null,
          opensource: r.opensource || false,
          obsolete: r.obsolete || false,
          isArchipelago: isArchipelago,
          comment: r.comment || null,
          addedDate: r['added-date'] || null,
          updatedDate: r['updated-date'] || null
        };
      });
      
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
  
  const metadata = {
    _id: '_metadata',
    lastSync: new Date(),
    commitHash,
    seriesCount: seriesData.length,
    totalGames: seriesData.reduce((sum, s) => sum + s.games.length, 0),
    totalRandomizers: seriesData.reduce((sum, s) => sum + s.randomizers.length, 0)
  };
  
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
 * Construit un index des randomizers par identifiant et nom de jeu
 */
function buildRandomizerIndex(seriesData) {
  const byIdentifier = new Map();
  const byGameName = new Map();
  
  for (const series of seriesData) {
    for (const rando of series.randomizers) {
      if (rando.obsolete) continue;
      
      // Index par identifier
      if (rando.identifier) {
        byIdentifier.set(rando.identifier.toLowerCase(), {
          ...rando,
          seriesFile: series.seriesFile,
          seriesName: series.seriesName
        });
      }
      
      // Index par nom de jeu
      for (const gameName of rando.games) {
        const key = normalizeGameName(gameName);
        if (!byGameName.has(key)) {
          byGameName.set(key, []);
        }
        byGameName.get(key).push({
          ...rando,
          gameName,
          seriesFile: series.seriesFile,
          seriesName: series.seriesName
        });
      }
    }
  }
  
  return { byIdentifier, byGameName };
}

function normalizeGameName(name) {
  return name.toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/thelegendofzelda/g, 'zelda')
    .replace(/supermetroid/g, 'sm')
    .replace(/randomizer/g, '');
}

/**
 * Met à jour les ressources des Games existants
 */
async function updateGameResources(seriesData, dryRun = false) {
  console.log('\n🔗 Mise à jour des ressources des jeux...');
  
  const games = await Game.find({ enabled: { $ne: false } });
  console.log(`  ${games.length} jeux en BDD`);
  
  const { byIdentifier, byGameName } = buildRandomizerIndex(seriesData);
  
  const stats = { updated: 0, notFound: 0, multipleUrls: 0 };
  
  for (const game of games) {
    // Chercher les infos rando-list pour ce jeu
    let matchedRandomizers = [];
    
    // 1. Essayer par l'identifier stocké dans integrations
    const storedIdentifier = game.integrations?.randoList?.randomizerIdentifier;
    if (storedIdentifier && byIdentifier.has(storedIdentifier.toLowerCase())) {
      matchedRandomizers.push(byIdentifier.get(storedIdentifier.toLowerCase()));
    }
    
    // 2. Chercher par nom de jeu
    const namesToTry = [
      game.name,
      game.official?.name,
      game.randomizer?.name,
      game.randomizer?.shortName
    ].filter(Boolean);
    
    for (const name of namesToTry) {
      const normalized = normalizeGameName(name);
      if (byGameName.has(normalized)) {
        matchedRandomizers.push(...byGameName.get(normalized));
      }
    }
    
    // Dédupliquer
    const uniqueRandomizers = [];
    const seenIds = new Set();
    for (const r of matchedRandomizers) {
      if (!seenIds.has(r.identifier)) {
        seenIds.add(r.identifier);
        uniqueRandomizers.push(r);
      }
    }
    
    if (uniqueRandomizers.length === 0) {
      stats.notFound++;
      continue;
    }
    
    // Construire la liste des sites
    const sites = uniqueRandomizers
      .filter(r => r.url)
      .map(r => ({
        url: r.url,
        name: r.name || r.identifier || extractDomainName(r.url),
        source: 'rando-list',
        isArchipelago: r.isArchipelago || false,
        isObsolete: r.obsolete || false
      }));
    
    if (sites.length === 0) continue;
    
    // Déterminer le site officiel
    let officialSite = null;
    const activeSites = sites.filter(s => !s.isObsolete);
    
    if (activeSites.length === 1) {
      // Un seul site = c'est le site officiel
      officialSite = {
        url: activeSites[0].url,
        name: activeSites[0].isArchipelago ? 'Archipelago' : 'Site officiel',
        isArchipelago: activeSites[0].isArchipelago
      };
    } else if (activeSites.length > 1) {
      stats.multipleUrls++;
      // Plusieurs sites: ne pas définir automatiquement le site officiel
      // (sera géré manuellement)
    }
    
    // Préparer la mise à jour
    const updates = {
      'resources.sites': sites
    };
    
    // Ne mettre à jour le site officiel que s'il n'est pas déjà défini manuellement
    if (officialSite && !game.resources?.officialSite?.url) {
      updates['resources.officialSite'] = officialSite;
    }
    
    // Mettre à jour les infos randomizer
    const primaryRando = uniqueRandomizers[0];
    if (primaryRando) {
      if (primaryRando.opensource !== undefined) {
        updates['randomizer.opensource'] = primaryRando.opensource;
      }
      if (primaryRando.addedDate) {
        updates['randomizer.addedDate'] = new Date(primaryRando.addedDate);
      }
      if (primaryRando.updatedDate) {
        updates['randomizer.updatedDate'] = new Date(primaryRando.updatedDate);
      }
    }
    
    if (dryRun) {
      console.log(`  📋 [DRY-RUN] ${game.id}: ${sites.length} site(s)`);
    } else {
      await Game.updateOne({ id: game.id }, { $set: updates });
      stats.updated++;
    }
  }
  
  console.log(`\n  ✓ ${stats.updated} mis à jour, ${stats.notFound} non trouvés, ${stats.multipleUrls} avec plusieurs URLs`);
  return stats;
}

function extractDomainName(url) {
  try {
    const hostname = new URL(url).hostname;
    return hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Détecte les nouveaux randomizers non encore en BDD
 */
async function detectNewRandomizers(seriesData) {
  console.log('\n🆕 Détection des nouveaux randomizers...');
  
  const existingGames = await Game.find({}).select('id integrations.randoList.randomizerIdentifier').lean();
  
  const existingIds = new Set();
  for (const game of existingGames) {
    existingIds.add(game.id.toLowerCase());
    if (game.integrations?.randoList?.randomizerIdentifier) {
      existingIds.add(game.integrations.randoList.randomizerIdentifier.toLowerCase());
    }
  }
  
  const newRandomizers = [];
  
  for (const series of seriesData) {
    for (const rando of series.randomizers) {
      if (rando.obsolete) continue;
      
      const identifier = (rando.identifier || '').toLowerCase();
      if (identifier && !existingIds.has(identifier)) {
        // Vérifier aussi par URL (peut correspondre à un jeu existant)
        let isNew = true;
        
        newRandomizers.push({
          identifier: rando.identifier,
          url: rando.url,
          games: rando.games,
          series: series.seriesName,
          isArchipelago: rando.isArchipelago
        });
      }
    }
  }
  
  if (newRandomizers.length > 0) {
    console.log(`  📋 ${newRandomizers.length} nouveau(x) randomizer(s) détecté(s):`);
    newRandomizers.slice(0, 10).forEach(r => {
      console.log(`    - ${r.identifier} (${r.series}): ${r.games.join(', ')}`);
    });
    if (newRandomizers.length > 10) {
      console.log(`    ... et ${newRandomizers.length - 10} autres`);
    }
  } else {
    console.log('  ✓ Aucun nouveau randomizer');
  }
  
  return newRandomizers;
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--help')) {
    console.log(`
Usage: node sync-rando-list-v3.js [options]

Options:
  --link-games       Lier automatiquement les Games existants
  --update-resources Mettre à jour uniquement les ressources
  --dry-run          Mode simulation
  --help             Affiche cette aide
`);
    process.exit(0);
  }
  
  const linkGames = args.includes('--link-games');
  const updateResourcesOnly = args.includes('--update-resources');
  const dryRun = args.includes('--dry-run');
  
  console.log('🔄 Sync Rando-List V3\n');
  
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
    
    // 4. Sauvegarder dans le cache (sauf si update-resources only)
    if (!updateResourcesOnly) {
      await saveToCacheCollection(seriesData, commitHash);
    }
    
    // 5. Mettre à jour les ressources des jeux
    await updateGameResources(seriesData, dryRun);
    
    // 6. Détecter les nouveaux randomizers
    const newRandomizers = await detectNewRandomizers(seriesData);
    
    console.log('\n✅ Sync terminé avec succès');
    
    // Retourner les infos pour le workflow GitHub Actions
    if (newRandomizers.length > 0) {
      console.log('\n--- NEW_RANDOMIZERS_JSON ---');
      console.log(JSON.stringify(newRandomizers.map(r => r.identifier)));
      console.log('--- END_NEW_RANDOMIZERS_JSON ---');
    }
    
  } catch (error) {
    console.error('\n❌ Erreur:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

main();
