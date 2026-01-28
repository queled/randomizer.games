#!/usr/bin/env node
/**
 * Migration: Fix Race URLs
 * 
 * Corrige les URLs de courses qui ont été importées avec un double slug
 * (par exemple /hodbt/hodbt/lawful-jigglypuff-8917 au lieu de /hodbt/lawful-jigglypuff-8917)
 * 
 * Usage:
 *   node scripts/migrations/fix-race-urls.js           # Dry run (preview)
 *   node scripts/migrations/fix-race-urls.js --apply   # Apply fixes
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const connectDB = require('../../config/database');
const { Race } = require('../../models');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--apply');
  
  if (dryRun) {
    console.log('🔍 Mode DRY RUN - aucune modification ne sera effectuée');
    console.log('   Utilisez --apply pour appliquer les corrections\n');
  } else {
    console.log('⚠️  Mode APPLY - les modifications seront appliquées\n');
  }
  
  try {
    await connectDB();
    
    // Trouver toutes les races avec des URLs potentiellement dupliquées
    const races = await Race.find({}).lean();
    
    console.log(`📊 ${races.length} courses trouvées\n`);
    
    let fixedCount = 0;
    let skippedCount = 0;
    
    for (const race of races) {
      if (!race.url) {
        skippedCount++;
        continue;
      }
      
      // Détecter les URLs avec double slug
      // Pattern: /slug/slug/race-name ou similaire
      const urlParts = race.url.split('/').filter(Boolean);
      
      if (urlParts.length >= 2 && urlParts[0] === urlParts[1]) {
        // Double slug détecté!
        const correctedUrl = '/' + urlParts.slice(1).join('/');
        
        console.log(`🔧 Course: ${race.name || race._id}`);
        console.log(`   Ancienne URL: ${race.url}`);
        console.log(`   Nouvelle URL: ${correctedUrl}`);
        
        if (!dryRun) {
          await Race.updateOne(
            { _id: race._id },
            { $set: { url: correctedUrl } }
          );
          console.log(`   ✅ Corrigée`);
        } else {
          console.log(`   ⏸️  (dry run)`);
        }
        console.log('');
        
        fixedCount++;
      } else {
        skippedCount++;
      }
    }
    
    console.log('════════════════════════════════════');
    console.log(`✅ ${fixedCount} URLs à corriger`);
    console.log(`⏭️  ${skippedCount} URLs déjà correctes`);
    
    if (dryRun && fixedCount > 0) {
      console.log('\n💡 Exécutez avec --apply pour appliquer les corrections');
    }
    
  } catch (error) {
    console.error('\n❌ Erreur:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

main();
