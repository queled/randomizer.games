#!/usr/bin/env node
/**
 * Sync Rando-List
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
 *   node scripts/sync-rando-list.js                    # Sync cache + ressources
 *   node scripts/sync-rando-list.js --link-games       # Sync + liaison aux Games
 *   node scripts/sync-rando-list.js --update-resources # Met à jour les ressources uniquement
 *   node scripts/sync-rando-list.js --dry-run          # Affiche sans modifier
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const yaml = require('js-yaml');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

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
    .replace(/^\([ivx]+(-[ivx]+)?\)\s*/, '') // generation prefix of a series file, e.g. "(III) Name"
    .replace(/[^a-z0-9]/g, '')
    .replace(/thelegendofzelda/g, 'zelda')
    .replace(/supermetroid/g, 'sm')
    .replace(/randomizer/g, '');
}

/**
 * Met à jour les ressources des Games existants
 * NOTE: N'écrase pas les jeux dont source.origin='manual' ou les noms curés manuellement
 */
async function updateGameResources(seriesData, dryRun = false) {
  console.log('\n🔗 Mise à jour des ressources des jeux...');
  
  const games = await Game.find({ enabled: { $ne: false } });
  console.log(`  ${games.length} jeux en BDD`);
  
  const { byIdentifier, byGameName } = buildRandomizerIndex(seriesData);
  
  const stats = { updated: 0, notFound: 0, multipleUrls: 0, skippedManual: 0 };
  
  for (const game of games) {
    // === PROTECTION DES DONNÉES MANUELLES ===
    // Ne pas écraser les jeux qui ont été importés/curés manuellement
    const origin = game.source?.origin;
    if (origin === 'manual') {
      stats.skippedManual++;
      continue;
    }
    
    // Si le jeu a un randoList.confidence = 'manual', on ne modifie que les sites
    const isManuallyLinked = game.integrations?.randoList?.confidence === 'manual';
    
    // Chercher les infos rando-list pour ce jeu
    let matchedRandomizers = [];
    
    // 1. Essayer par l'identifier stocké dans integrations
    const storedIdentifier = game.integrations?.randoList?.randomizerIdentifier;
    if (storedIdentifier && byIdentifier.has(storedIdentifier.toLowerCase())) {
      matchedRandomizers.push(byIdentifier.get(storedIdentifier.toLowerCase()));
    }
    
    // 2. Chercher par nom de jeu
    // A short name reduced to an abbreviation ("XY Randomizer" → "xy") collides with other games
    const shortName = game.randomizer?.shortName;
    const namesToTry = [
      game.name,
      game.official?.name,
      game.randomizer?.name,
      shortName && normalizeGameName(shortName).length > 3 ? shortName : null,
      game.integrations?.randoList?.gameName,
      ...(game.integrations?.randoList?.gameNames || [])
    ].filter(Boolean);
    
    // Exact rando-list names found, kept on the game so that the link survives a rename
    const matchedNames = new Set();
    for (const name of namesToTry) {
      const normalized = normalizeGameName(name);
      if (byGameName.has(normalized)) {
        matchedRandomizers.push(...byGameName.get(normalized));
        byGameName.get(normalized).forEach(r => matchedNames.add(r.gameName));
      }
    }
    
    // Dédupliquer par URL : un même randomizer peut avoir un lien par version du jeu (jeux fusionnés)
    const uniqueRandomizers = [];
    const seenKeys = new Set();
    for (const r of matchedRandomizers) {
      const key = r.url || r.identifier;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
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
    // Pour les jeux manuellement liés, on ne met à jour QUE les sites (pas les infos randomizer)
    const updates = {};
    
    // Toujours mettre à jour les sites (fusion avec les existants pour éviter d'écraser
    // les sites manuels et ceux d'Archipelago / Multiworld)
    const existingManualSites = (game.resources?.sites || [])
      .filter(s => s.source !== 'rando-list');
    const allSites = [...sites];
    // Ajouter les sites manuels qui n'existent pas déjà
    for (const manualSite of existingManualSites) {
      if (!allSites.find(s => s.url === manualSite.url)) {
        allSites.push(manualSite);
      }
    }
    updates['resources.sites'] = allSites;
    
    // Ne mettre à jour le site officiel que s'il n'est pas déjà défini manuellement
    if (officialSite && !game.resources?.officialSite?.url) {
      updates['resources.officialSite'] = officialSite;
    }
    
    // Mettre à jour les infos randomizer SEULEMENT si pas de liaison manuelle
    if (!isManuallyLinked) {
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
    }
    
    if (dryRun) {
      console.log(`  📋 [DRY-RUN] ${game.id}: ${allSites.length} site(s)${isManuallyLinked ? ' (liaison manuelle)' : ''}`);
    } else {
      const randoListNames = randoListNamesUpdate(game, matchedNames);
      Object.assign(updates, randoListNames.$set);
      await Game.updateOne({ id: game.id }, { $set: updates, ...(randoListNames.$addToSet && { $addToSet: randoListNames.$addToSet }) });
      stats.updated++;
    }
  }
  
  console.log(`\n  ✓ ${stats.updated} mis à jour, ${stats.skippedManual} jeux manuels ignorés, ${stats.notFound} non trouvés, ${stats.multipleUrls} avec plusieurs URLs`);
  return stats;
}

/**
 * Update that records the rando-list names matched for a game: the first one becomes
 * integrations.randoList.gameName if the game has none, the others go to gameNames.
 */
function randoListNamesUpdate(game, matchedNames) {
  const current = game.integrations?.randoList || {};
  const known = new Set([current.gameName, ...(current.gameNames || [])].filter(Boolean));
  const missing = [...matchedNames].filter(name => !known.has(name));
  if (missing.length === 0) return {};

  const update = {};
  if (!current.gameName) {
    update.$set = { 'integrations.randoList.gameName': missing.shift() };
  }
  if (missing.length > 0) {
    update.$addToSet = { 'integrations.randoList.gameNames': { $each: missing } };
  }
  return update;
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
 * Détecte les nouveaux JEUX (pas randomizers) non encore en BDD
 * Un jeu = une entrée dans games de rando-list
 */
async function detectNewGames(seriesData) {
  console.log('\n🆕 Détection des nouveaux jeux...');
  
  // Récupérer tous les jeux existants et leurs noms connus
  const existingGames = await Game.find({}).select('id name displayName officialName integrations.randoList').lean();
  
  // Index des noms de jeux existants (normalisés)
  const existingNames = new Set();
  for (const game of existingGames) {
    existingNames.add(normalizeGameName(game.id));
    if (game.name) existingNames.add(normalizeGameName(game.name));
    if (game.displayName) existingNames.add(normalizeGameName(game.displayName));
    if (game.officialName) existingNames.add(normalizeGameName(game.officialName));
    if (game.integrations?.randoList?.gameName) {
      existingNames.add(normalizeGameName(game.integrations.randoList.gameName));
    }
    for (const name of game.integrations?.randoList?.gameNames || []) {
      existingNames.add(normalizeGameName(name));
    }
  }
  
  // Collecter tous les jeux uniques de rando-list
  const allGamesFromRandoList = new Map(); // gameName normalisé -> infos du jeu
  
  for (const series of seriesData) {
    // series.games est un TABLEAU d'objets {name, genres, platforms, ...}
    for (const gameData of series.games) {
      const gameName = gameData.name;
      const normalizedName = normalizeGameName(gameName);
      
      if (!allGamesFromRandoList.has(normalizedName)) {
        // Trouver les randomizers pour ce jeu
        const gameRandomizers = series.randomizers.filter(r => 
          r.games.some(g => normalizeGameName(g) === normalizedName)
        );
        
        allGamesFromRandoList.set(normalizedName, {
          name: gameName,
          series: series.seriesName,
          seriesFile: series.seriesFile,
          genres: gameData.genres || [],
          platforms: gameData.platforms || [],
          releaseDate: gameData.releaseDate,
          randomizers: gameRandomizers.map(r => ({
            identifier: r.identifier,
            url: r.url,
            name: r.name,
            isArchipelago: r.isArchipelago || false,
            obsolete: r.obsolete || false,
            opensource: r.opensource || false
          }))
        });
      } else {
        // Fusionner les randomizers si le jeu existe déjà dans une autre série
        const existing = allGamesFromRandoList.get(normalizedName);
        const gameRandomizers = series.randomizers.filter(r => 
          r.games.some(g => normalizeGameName(g) === normalizedName)
        );
        for (const r of gameRandomizers) {
          if (!existing.randomizers.find(er => er.identifier === r.identifier)) {
            existing.randomizers.push({
              identifier: r.identifier,
              url: r.url,
              name: r.name,
              isArchipelago: r.isArchipelago || false,
              obsolete: r.obsolete || false,
              opensource: r.opensource || false
            });
          }
        }
      }
    }
  }
  
  // Trouver les jeux qui ne sont pas en BDD
  const newGames = [];
  for (const [normalizedName, gameInfo] of allGamesFromRandoList) {
    if (!existingNames.has(normalizedName)) {
      // Ne garder que les jeux qui ont au moins un randomizer actif
      const activeRandomizers = gameInfo.randomizers.filter(r => !r.obsolete);
      if (activeRandomizers.length > 0) {
        newGames.push({
          ...gameInfo,
          activeRandomizers
        });
      }
    }
  }
  
  if (newGames.length > 0) {
    console.log(`  📋 ${newGames.length} nouveau(x) jeu(x) détecté(s):`);
    newGames.slice(0, 15).forEach(g => {
      console.log(`    - ${g.name} (${g.series}) - ${g.activeRandomizers.length} randomizer(s)`);
    });
    if (newGames.length > 15) {
      console.log(`    ... et ${newGames.length - 15} autres`);
    }
  } else {
    console.log('  ✓ Aucun nouveau jeu');
  }
  
  return newGames;
}

/**
 * Génère un rapport des nouveaux jeux pour création manuelle
 */
async function generateNewGamesReport(newGames, outputPath = null) {
  if (newGames.length === 0) {
    console.log('\n✅ Aucun nouveau jeu à rapporter');
    return;
  }
  
  console.log('\n📝 Génération du rapport des nouveaux jeux...');
  
  const report = {
    generatedAt: new Date().toISOString(),
    totalNewGames: newGames.length,
    games: newGames.map(g => {
      // Générer des suggestions d'ID
      const suggestedId = generateGameId(g.name);
      
      return {
        originalName: g.name,
        series: g.series,
        suggestedId: suggestedId,
        // Les champs que l'utilisateur doit remplir:
        id: suggestedId, // À modifier si besoin
        displayName: g.name, // Le titre du jeu
        randomizerName: `${g.name} Randomizer`,
        randomizerShortName: `${suggestedId.toUpperCase()} Rando`,
        randomizerTinyName: suggestedId.toUpperCase(),
        platforms: g.platforms,
        genres: g.genres,
        randomizers: g.activeRandomizers.map(r => ({
          name: r.identifier,
          url: r.url,
          isArchipelago: r.isArchipelago,
          isMain: false // À définir par l'utilisateur
        }))
      };
    })
  };
  
  // Afficher dans la console
  console.log('\n--- NEW_GAMES_REPORT ---');
  console.log(JSON.stringify(report, null, 2));
  console.log('--- END_NEW_GAMES_REPORT ---');
  
  // Sauvegarder dans un fichier si demandé
  if (outputPath) {
    const fs = require('fs');
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
    console.log(`\n📄 Rapport sauvegardé: ${outputPath}`);
  }
  
  return report;
}

/**
 * Génère un ID de jeu à partir du nom
 */
function generateGameId(gameName) {
  // Extraire les initiales si le nom est long
  const words = gameName
    .replace(/[():\-–—]/g, ' ')
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 0);
  
  // Si le nom est court, utiliser le nom complet
  if (words.length <= 2) {
    return words.join('-').toLowerCase();
  }
  
  // Sinon, générer des initiales
  const significantWords = words.filter(w => 
    !['the', 'a', 'an', 'of', 'and', 'in', 'on', 'at', 'to', 'for'].includes(w.toLowerCase())
  );
  
  if (significantWords.length <= 4) {
    return significantWords.map(w => w.charAt(0).toLowerCase()).join('');
  }
  
  // Prendre les premières lettres
  return words.slice(0, 4).map(w => w.charAt(0).toLowerCase()).join('');
}

/**
 * Détecte les nouveaux randomizers non encore en BDD (ancienne fonction, conservée pour compatibilité)
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
        newRandomizers.push({
          identifier: rando.identifier,
          url: rando.url,
          name: rando.name,
          games: rando.games,
          series: series.seriesName,
          seriesFile: series.seriesFile,
          isArchipelago: rando.isArchipelago,
          opensource: rando.opensource,
          addedDate: rando.addedDate,
          multiworld: rando.multiworld
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
Usage: node sync-rando-list.js [options]

Options:
  --link-games       Lier automatiquement les Games existants
  --detect-new       Détecter les nouveaux jeux et générer un rapport
  --report-path      Chemin du fichier de rapport (défaut: tmp/new-games-report.json)
  --update-resources Mettre à jour uniquement les ressources
  --dry-run          Mode simulation
  --help             Affiche cette aide

Workflow recommandé:
  1. node sync-rando-list.js --detect-new     # Voir les nouveaux jeux
  2. Relire le rapport généré
  3. Créer les jeux retenus depuis le panneau admin
`);
    process.exit(0);
  }
  
  const linkGames = args.includes('--link-games');
  const detectNew = args.includes('--detect-new');
  const updateResourcesOnly = args.includes('--update-resources');
  const dryRun = args.includes('--dry-run');
  
  // Chemin du rapport
  const reportPathIndex = args.indexOf('--report-path');
  const reportPath = reportPathIndex > -1 && args[reportPathIndex + 1] 
    ? args[reportPathIndex + 1] 
    : path.join(__dirname, 'tmp', 'new-games-report.json');
  
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
    
    // 4. Sauvegarder dans le cache (sauf si update-resources only)
    if (!updateResourcesOnly) {
      await saveToCacheCollection(seriesData, commitHash);
    }
    
    // 5. Mettre à jour les ressources des jeux existants
    await updateGameResources(seriesData, dryRun);
    
    // 6. Détecter les nouveaux jeux (pas les randomizers)
    const newGames = await detectNewGames(seriesData);
    
    // 7. Générer le rapport si demandé
    if (detectNew && newGames.length > 0) {
      // Créer le dossier tmp si nécessaire
      const tmpDir = path.dirname(reportPath);
      if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
      }
      await generateNewGamesReport(newGames, reportPath);
    }
    
    console.log('\n✅ Sync terminé avec succès');
    
    // Retourner les infos pour le workflow GitHub Actions
    if (newGames.length > 0) {
      console.log('\n--- SYNC_RESULTS_JSON ---');
      console.log(JSON.stringify({
        newGamesCount: newGames.length,
        newGames: newGames.slice(0, 20).map(g => ({
          name: g.name,
          series: g.series,
          randomizersCount: g.activeRandomizers.length
        }))
      }));
      console.log('--- END_SYNC_RESULTS_JSON ---');
    }
    
  } catch (error) {
    console.error('\n❌ Erreur:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main();
}

module.exports = { syncRepo, parseSeriesFiles, buildRandomizerIndex, normalizeGameName, randoListNamesUpdate };
