#!/usr/bin/env node
/**
 * Import Games from CSV
 * 
 * Ce script importe/met à jour les jeux depuis un fichier CSV.
 * 
 * IMPORTANT: Ce script est SAFE par défaut:
 * - Mode --dry-run: affiche ce qui serait fait sans modifier la BDD
 * - Mode --link-only: ajoute uniquement les liens d'intégrations sans écraser les données existantes
 * - Mode --full: import complet (attention: écrase les données existantes)
 * 
 * Usage:
 *   node scripts/import-games-csv.js path/to/games.csv --dry-run
 *   node scripts/import-games-csv.js path/to/games.csv --link-only
 *   node scripts/import-games-csv.js path/to/games.csv --full
 * 
 * Format CSV attendu (colonnes):
 *   my id, id game speedrun.com, id rando racetime.gg, very shortname rando racetime.gg,
 *   shortname rando, official rando name, game name, full game name, full rando name,
 *   année de sortie du jeu, série, plateforme
 */

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { parse } = require('csv-parse/sync');

// Chargement de la configuration
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const connectDB = require('../config/database');
const { Game } = require('../models');

// Mapping des colonnes CSV vers nos champs
const CSV_COLUMN_MAP = {
  'my id': 'id',
  'id game speedrun.com': 'speedrunId',
  'id rando racetime.gg': 'racetimeSlug',
  'very shortname rando racetime.gg': 'racetimeShortName',
  'shortname rando': 'shortName',                    // Acronyme
  'official rando name': 'randomizerDisplayName',    // Pour affichage
  'game name': 'gameName',
  'full game name': 'fullGameName',
  'full rando name': 'fullRandoName',                // Nom complet
  'année de sortie du jeu': 'releaseYear',
  'série': 'series',
  'plateforme': 'platforms'
};

function parseCSV(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true
  });
  
  return records.map(row => {
    const normalized = {};
    for (const [csvCol, fieldName] of Object.entries(CSV_COLUMN_MAP)) {
      const value = row[csvCol] || row[csvCol.toLowerCase()] || row[csvCol.replace(/ /g, '_')];
      if (value !== undefined && value !== '') {
        normalized[fieldName] = value;
      }
    }
    return normalized;
  });
}

function parsePlatforms(platformStr) {
  if (!platformStr) return [];
  return platformStr.split(/[,;]/).map(p => p.trim()).filter(Boolean);
}

function parseReleaseDate(yearStr) {
  if (!yearStr) return null;
  const year = parseInt(yearStr, 10);
  if (isNaN(year) || year < 1970 || year > 2100) return null;
  return new Date(year, 0, 1); // 1er janvier de l'année
}

async function importGames(csvPath, options = {}) {
  const { dryRun = false, linkOnly = false } = options;
  
  console.log('📁 Lecture du fichier CSV:', csvPath);
  const records = parseCSV(csvPath);
  console.log(`📊 ${records.length} entrées trouvées\n`);
  
  const stats = {
    created: 0,
    updated: 0,
    linked: 0,
    skipped: 0,
    errors: []
  };
  
  for (const record of records) {
    if (!record.id) {
      stats.errors.push({ record, error: 'ID manquant' });
      continue;
    }
    
    const gameId = record.id.toLowerCase().trim();
    
    try {
      const existing = await Game.findOne({ id: gameId });
      
      if (linkOnly && !existing) {
        console.log(`⏭️  [SKIP] ${gameId} - n'existe pas en BDD (mode link-only)`);
        stats.skipped++;
        continue;
      }
      
      // Préparer les données d'intégrations
      const integrations = {};
      
      if (record.speedrunId) {
        integrations['integrations.speedrun'] = {
          enabled: true,
          gameId: record.speedrunId,
          confidence: 'manual',
          lastSync: new Date()
        };
      }
      
      if (record.racetimeSlug) {
        integrations['integrations.racetime'] = {
          enabled: true,
          gameSlug: record.racetimeSlug.toLowerCase(),
          gameName: record.racetimeShortName || null,
          confidence: 'manual',
          lastSync: new Date()
        };
      }
      
      if (existing) {
        // === MODE UPDATE ===
        if (linkOnly) {
          // Ajouter uniquement les intégrations sans toucher aux autres champs
          if (dryRun) {
            console.log(`🔗 [DRY-RUN] ${gameId} - ajouterait les liens:`, Object.keys(integrations));
          } else {
            await Game.updateOne(
              { id: gameId },
              { $set: integrations }
            );
            console.log(`🔗 [LINKED] ${gameId} - intégrations ajoutées`);
          }
          stats.linked++;
        } else {
          // Full update
          const updateData = buildFullUpdateData(record, integrations);
          if (dryRun) {
            console.log(`📝 [DRY-RUN] ${gameId} - mettrait à jour:`, Object.keys(updateData));
          } else {
            await Game.updateOne({ id: gameId }, { $set: updateData });
            console.log(`📝 [UPDATED] ${gameId}`);
          }
          stats.updated++;
        }
      } else {
        // === MODE CREATE ===
        const newGame = buildNewGameData(record, gameId, integrations);
        if (dryRun) {
          console.log(`✨ [DRY-RUN] ${gameId} - créerait:`, newGame.name);
        } else {
          await Game.create(newGame);
          console.log(`✨ [CREATED] ${gameId} - ${newGame.name}`);
        }
        stats.created++;
      }
      
    } catch (error) {
      console.error(`❌ [ERROR] ${gameId}:`, error.message);
      stats.errors.push({ id: gameId, error: error.message });
    }
  }
  
  return stats;
}

function buildFullUpdateData(record, integrations) {
  const data = { ...integrations };
  
  // name = nom court du jeu
  if (record.gameName) data.name = record.gameName;
  
  // randomizer.shortName = acronyme du randomizer
  if (record.shortName) data['randomizer.shortName'] = record.shortName;
  
  if (record.series) data.series = record.series;
  if (record.platforms) data.platforms = parsePlatforms(record.platforms);
  
  // official.name = nom complet officiel du jeu
  if (record.fullGameName) data['official.name'] = record.fullGameName;
  if (record.releaseYear) data['official.releaseDate'] = parseReleaseDate(record.releaseYear);
  
  // randomizer.displayName = nom pour affichage
  if (record.randomizerDisplayName) {
    data['randomizer.displayName'] = record.randomizerDisplayName;
  }
  
  // randomizer.name = nom complet du randomizer
  if (record.fullRandoName) {
    const cleaned = record.fullRandoName.replace(/\s+Randomizer\s+Randomizer$/i, ' Randomizer');
    data['randomizer.name'] = cleaned;
  }
  
  data['source.origin'] = 'csv-import';
  data['source.importedAt'] = new Date();
  
  return data;
}

function buildNewGameData(record, gameId, integrations) {
  const fullRandoName = record.fullRandoName ? record.fullRandoName.replace(/\s+Randomizer\s+Randomizer$/i, ' Randomizer') : null;
  
  return {
    id: gameId,
    // name = nom court du jeu
    name: record.gameName || record.fullGameName || gameId,
    series: record.series || null,
    platforms: parsePlatforms(record.platforms),
    logo: `assets/${gameId}.png`,
    image: `assets/${gameId}.png`,
    official: {
      name: record.fullGameName || null,
      releaseDate: parseReleaseDate(record.releaseYear),
      website: null
    },
    randomizer: {
      // displayName = nom pour affichage
      displayName: record.randomizerDisplayName || null,
      shortName: record.shortName || `${gameId.toUpperCase()} Randomizer`,
      tinyName: record.tinyName || null,
      // name = nom complet
      name: fullRandoName,
      website: null,
      opensource: null
    },
    integrations: {
      speedrun: integrations['integrations.speedrun'] ? {
        ...integrations['integrations.speedrun']
      } : { enabled: false },
      racetime: integrations['integrations.racetime'] ? {
        ...integrations['integrations.racetime']
      } : { enabled: false },
      randoList: { enabled: false }
    },
    source: {
      origin: 'csv-import',
      importedAt: new Date()
    },
    enabled: true,
    categories: []
  };
}

function printStats(stats, dryRun) {
  console.log('\n' + '='.repeat(50));
  console.log(dryRun ? '📋 RÉSUMÉ (DRY-RUN - aucune modification)' : '📋 RÉSUMÉ');
  console.log('='.repeat(50));
  console.log(`✨ Créés:    ${stats.created}`);
  console.log(`📝 Mis à jour: ${stats.updated}`);
  console.log(`🔗 Liés:     ${stats.linked}`);
  console.log(`⏭️  Ignorés:  ${stats.skipped}`);
  console.log(`❌ Erreurs:  ${stats.errors.length}`);
  
  if (stats.errors.length > 0) {
    console.log('\nDétail des erreurs:');
    stats.errors.forEach(e => {
      console.log(`  - ${e.id || 'Unknown'}: ${e.error}`);
    });
  }
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('--help')) {
    console.log(`
Usage: node import-games-csv.js <fichier.csv> [options]

Options:
  --dry-run    Affiche ce qui serait fait sans modifier la BDD
  --link-only  Ajoute uniquement les liens d'intégrations (safe)
  --full       Import complet (écrase les données existantes)
  --help       Affiche cette aide

Exemples:
  node scripts/import-games-csv.js data/games.csv --dry-run
  node scripts/import-games-csv.js data/games.csv --link-only
`);
    process.exit(0);
  }
  
  const csvPath = args.find(a => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  const linkOnly = args.includes('--link-only');
  const full = args.includes('--full');
  
  if (!csvPath) {
    console.error('❌ Veuillez spécifier un fichier CSV');
    process.exit(1);
  }
  
  if (!fs.existsSync(csvPath)) {
    console.error(`❌ Fichier non trouvé: ${csvPath}`);
    process.exit(1);
  }
  
  if (!dryRun && !linkOnly && !full) {
    console.log('⚠️  Aucun mode spécifié. Utilisation de --dry-run par défaut.');
    console.log('   Utilisez --link-only ou --full pour effectuer des modifications.\n');
  }
  
  const effectiveDryRun = dryRun || (!linkOnly && !full);
  
  console.log('🎮 Import de jeux depuis CSV');
  console.log('Mode:', effectiveDryRun ? 'DRY-RUN' : linkOnly ? 'LINK-ONLY' : 'FULL');
  console.log('');
  
  try {
    await connectDB();
    const stats = await importGames(csvPath, { 
      dryRun: effectiveDryRun, 
      linkOnly 
    });
    printStats(stats, effectiveDryRun);
    
  } catch (error) {
    console.error('❌ Erreur fatale:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

main();
