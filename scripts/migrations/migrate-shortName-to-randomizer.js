#!/usr/bin/env node
/**
 * Migration: Déplacer shortName et tinyName vers randomizer
 * 
 * Cette migration déplace les champs shortName et tinyName de la racine
 * vers l'objet randomizer pour une meilleure organisation du schéma.
 * 
 * Avant:
 *   { shortName: "ALttP Randomizer", tinyName: "ALttPR", randomizer: { displayName: "..." } }
 * 
 * Après:
 *   { randomizer: { shortName: "ALttP Randomizer", tinyName: "ALttPR", displayName: "..." } }
 * 
 * Usage:
 *   node scripts/migrations/migrate-shortName-to-randomizer.js [--dry-run]
 */

const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/randomizer';
const DRY_RUN = process.argv.includes('--dry-run');

async function migrate() {
  console.log('🚀 Migration: Déplacer shortName et tinyName vers randomizer');
  console.log(`   Mode: ${DRY_RUN ? '🔍 DRY RUN (aucune modification)' : '⚠️  PRODUCTION'}`);
  console.log('');
  
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connecté à MongoDB');
    
    const db = mongoose.connection.db;
    const gamesCollection = db.collection('games');
    
    // Trouver tous les jeux qui ont shortName ou tinyName à la racine
    const gamesToMigrate = await gamesCollection.find({
      $or: [
        { shortName: { $exists: true } },
        { tinyName: { $exists: true } }
      ]
    }).toArray();
    
    console.log(`📊 Jeux à migrer: ${gamesToMigrate.length}`);
    console.log('');
    
    let migratedCount = 0;
    let skippedCount = 0;
    
    for (const game of gamesToMigrate) {
      const updates = {};
      const unsets = {};
      
      // Migrer shortName
      if (game.shortName) {
        // Seulement si randomizer.shortName n'existe pas déjà
        if (!game.randomizer?.shortName) {
          updates['randomizer.shortName'] = game.shortName;
        }
        unsets.shortName = '';
      }
      
      // Migrer tinyName
      if (game.tinyName) {
        // Seulement si randomizer.tinyName n'existe pas déjà
        if (!game.randomizer?.tinyName) {
          updates['randomizer.tinyName'] = game.tinyName;
        }
        unsets.tinyName = '';
      }
      
      const hasUpdates = Object.keys(updates).length > 0 || Object.keys(unsets).length > 0;
      
      if (!hasUpdates) {
        console.log(`⏭️  ${game.id}: déjà migré ou rien à migrer`);
        skippedCount++;
        continue;
      }
      
      console.log(`📝 ${game.id}:`);
      if (game.shortName) {
        console.log(`   shortName: "${game.shortName}" → randomizer.shortName`);
      }
      if (game.tinyName) {
        console.log(`   tinyName: "${game.tinyName}" → randomizer.tinyName`);
      }
      
      if (!DRY_RUN) {
        const updateOp = {};
        if (Object.keys(updates).length > 0) {
          updateOp.$set = updates;
        }
        if (Object.keys(unsets).length > 0) {
          updateOp.$unset = unsets;
        }
        
        await gamesCollection.updateOne(
          { _id: game._id },
          updateOp
        );
      }
      
      migratedCount++;
    }
    
    console.log('');
    console.log('═══════════════════════════════════════');
    console.log(`✅ Migration terminée`);
    console.log(`   Migrés: ${migratedCount}`);
    console.log(`   Ignorés: ${skippedCount}`);
    
    if (DRY_RUN) {
      console.log('');
      console.log('💡 Pour appliquer les changements, exécutez sans --dry-run');
    }
    
  } catch (error) {
    console.error('❌ Erreur:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

migrate();
