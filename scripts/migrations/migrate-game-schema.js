#!/usr/bin/env node
/**
 * Migration: Upgrade Game Schema
 * 
 * Ce script migre les jeux existants vers le nouveau schéma avec integrations.
 * 
 * SAFE PAR DÉFAUT:
 * - Mode --dry-run affiche les changements sans les appliquer
 * - Préserve toutes les données existantes
 * - Ajoute les nouveaux champs avec des valeurs par défaut
 * 
 * Usage:
 *   node scripts/migrations/migrate-game-schema.js --dry-run
 *   node scripts/migrations/migrate-game-schema.js --apply
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const connectDB = require('../../config/database');

async function migrateGames(dryRun = true) {
  const collection = mongoose.connection.collection('games');
  
  const games = await collection.find({}).toArray();
  console.log(`\n📦 ${games.length} jeux à migrer\n`);
  
  const stats = { migrated: 0, skipped: 0, errors: 0 };
  
  for (const game of games) {
    try {
      // Vérifier si déjà migré
      if (game.integrations && game.official && game.randomizer) {
        console.log(`  ⏭️  ${game.id} - déjà migré`);
        stats.skipped++;
        continue;
      }
      
      const updates = {};
      
      // Migrer officialName → official.name
      if (game.officialName && !game.official?.name) {
        updates['official.name'] = game.officialName;
      }
      
      // Migrer officialWebsite → randomizer.website (car c'est le site du rando)
      if (game.officialWebsite && !game.randomizer?.website) {
        updates['randomizer.website'] = game.officialWebsite;
      }
      
      // Migrer releaseDate → official.releaseDate
      if (game.releaseDate && !game.official?.releaseDate) {
        updates['official.releaseDate'] = game.releaseDate;
      }
      
      // Initialiser les integrations si absent
      if (!game.integrations) {
        updates['integrations'] = {
          randoList: { enabled: false },
          racetime: { enabled: false },
          speedrun: { enabled: false }
        };
      }
      
      // Initialiser source si absent
      if (!game.source) {
        updates['source'] = {
          origin: 'seed',
          importedAt: game.createdAt || new Date()
        };
      }
      
      // Initialiser enabled si absent
      if (game.enabled === undefined) {
        updates['enabled'] = true;
      }
      
      if (Object.keys(updates).length === 0) {
        console.log(`  ✓ ${game.id} - rien à migrer`);
        stats.skipped++;
        continue;
      }
      
      if (dryRun) {
        console.log(`  📋 [DRY-RUN] ${game.id} - migrerait:`, Object.keys(updates));
      } else {
        await collection.updateOne(
          { _id: game._id },
          { $set: updates }
        );
        console.log(`  ✨ ${game.id} - migré`);
      }
      stats.migrated++;
      
    } catch (error) {
      console.error(`  ❌ ${game.id} - erreur:`, error.message);
      stats.errors++;
    }
  }
  
  // Optionnel: supprimer les anciens champs (commenté pour sécurité)
  // if (!dryRun) {
  //   await collection.updateMany(
  //     {},
  //     { $unset: { officialName: '', officialWebsite: '' } }
  //   );
  // }
  
  return stats;
}

function printStats(stats, dryRun) {
  console.log('\n' + '='.repeat(50));
  console.log(dryRun ? '📋 RÉSUMÉ (DRY-RUN)' : '📋 RÉSUMÉ');
  console.log('='.repeat(50));
  console.log(`✨ Migrés:   ${stats.migrated}`);
  console.log(`⏭️  Ignorés:  ${stats.skipped}`);
  console.log(`❌ Erreurs:  ${stats.errors}`);
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--help')) {
    console.log(`
Usage: node migrate-game-schema.js [options]

Options:
  --dry-run   Affiche ce qui serait fait (défaut)
  --apply     Applique les migrations
  --help      Affiche cette aide
`);
    process.exit(0);
  }
  
  const dryRun = !args.includes('--apply');
  
  console.log('🔄 Migration du schéma Game');
  console.log('Mode:', dryRun ? 'DRY-RUN' : 'PRODUCTION');
  
  try {
    await connectDB();
    const stats = await migrateGames(dryRun);
    printStats(stats, dryRun);
    
    if (dryRun) {
      console.log('\n💡 Pour appliquer: node migrate-game-schema.js --apply');
    }
    
  } catch (error) {
    console.error('\n❌ Erreur fatale:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

main();
