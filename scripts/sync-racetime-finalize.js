#!/usr/bin/env node
/**
 * Sync Racetime Finalize
 * 
 * Finalise les anciennes courses marquées "in_progress" qui n'ont jamais été mises à jour.
 * Cela arrive quand une sync manuelle longue se termine et n'a pas revisité les races
 * complétées mais passées.
 * 
 * Cette script doit être exécuté APRÈS une sync complète pour nettoyer les statuts.
 * 
 * Usage:
 *   node scripts/sync-racetime-finalize.js                 # Vérifier toutes les races in_progress
 *   node scripts/sync-racetime-finalize.js --max-age 30d   # Seulement races > 30 jours old
 *   node scripts/sync-racetime-finalize.js --dry-run        # Mode simulation
 *   node scripts/sync-racetime-finalize.js --limit 50       # Max 50 races à traiter
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const connectDB = require('../config/database');
const { Race } = require('../models');
const racetimeAPI = require('../services/racetime');

// Configuration
const RATE_LIMIT_MS = parseInt(process.env.RACETIME_RATE_LIMIT_MS) || 1500;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Parse --max-age parameter (e.g., "7d", "24h", "30m")
 */
function parseMaxAge(ageStr) {
  if (!ageStr) return null;
  
  const match = ageStr.match(/^(\d+)([dhm])$/);
  if (!match) return null;
  
  const value = parseInt(match[1]);
  const unit = match[2];
  
  let ms = 0;
  switch (unit) {
    case 'd': ms = value * 24 * 60 * 60 * 1000; break;
    case 'h': ms = value * 60 * 60 * 1000; break;
    case 'm': ms = value * 60 * 1000; break;
  }
  
  return ms;
}

/**
 * Finaliser les races en cours anciennes
 */
async function finalizeInProgressRaces(options = {}) {
  const { dryRun = false, maxAge = null, limit = 100 } = options;
  
  console.log('\n🏁 Finalisation des races en cours...');
  if (dryRun) console.log('  ⚠️  Mode simulation (dry-run)');
  if (maxAge) console.log(`  Seulement races > ${Math.round(maxAge / 1000 / 60 / 60)} heures`);
  
  // Chercher les races in_progress
  let query = {
    status: 'in_progress',
    startedAt: { $exists: true, $ne: null }
  };
  
  if (maxAge) {
    const cutoff = new Date(Date.now() - maxAge);
    query.startedAt = { $lt: cutoff };
  }
  
  const races = await Race.find(query)
    .sort({ startedAt: -1 })
    .limit(limit);
  
  console.log(`  ${races.length} races en cours trouvées`);
  
  if (races.length === 0) {
    console.log('  ℹ️  Aucune race à finaliser');
    return { checked: 0, updated: 0, errors: 0, noChange: 0 };
  }
  
  const stats = { checked: 0, updated: 0, errors: 0, noChange: 0 };
  
  for (const race of races) {
    // Extraire category et race ID depuis l'URL
    // URL format: /category/race-slug
    const urlParts = race.url.split('/').filter(Boolean);
    if (urlParts.length < 2) {
      console.log(`  ⚠️  Format URL invalide: ${race.url}`);
      stats.errors++;
      continue;
    }
    
    const category = urlParts[0];
    const raceId = urlParts[1];
    
    stats.checked++;
    
    try {
      await sleep(RATE_LIMIT_MS);
      
      // Récupérer les détails actuels de la race
      const raceDetail = await racetimeAPI.getRace(category, raceId);
      
      if (!raceDetail) {
        console.log(`  ⚠️  Race non trouvée: ${race.url}`);
        stats.errors++;
        continue;
      }
      
      const newStatus = raceDetail.status;
      
      // Si la race est encore in_progress, ne rien faire
      if (newStatus === 'in_progress') {
        console.log(`  ℹ️  ${race.url}: encore en cours`);
        stats.noChange++;
        continue;
      }
      
      // La race est terminée/annulée, la mettre à jour
      console.log(`  📋 ${race.url}: ${race.status} → ${newStatus}`);
      
      if (!dryRun) {
        const update = {
          $set: {
            status: newStatus,
            endedAt: raceDetail.endedAt,
            recordable: raceDetail.recordable,
            updatedAt: new Date()
          }
        };
        
        // Mettre à jour les entrants si présents
        if (raceDetail.entrants && Array.isArray(raceDetail.entrants) && raceDetail.entrants.length > 0) {
          update.$set.entrants = raceDetail.entrants.map(e => ({
            userId: e.user.id,
            userName: e.user.name,
            userDiscriminator: e.user.discriminator,
            userUrl: e.user.url,
            status: e.status.value,
            finishTime: e.finish_time,
            finishTimeMs: e.finishTimeMs,
            finishedAt: e.finished_at,
            place: e.place,
            placeOrdinal: e.place_ordinal,
            comment: e.comment
          }));
        }
        
        await Race.updateOne({ _id: race._id }, update);
      }
      
      stats.updated++;
      
    } catch (error) {
      console.error(`  ❌ Erreur: ${race.url} - ${error.message}`);
      stats.errors++;
    }
  }
  
  return stats;
}

async function main() {
  const args = process.argv.slice(2);
  
  const dryRun = args.includes('--dry-run');
  const maxAgeStr = args.includes('--max-age') 
    ? args[args.indexOf('--max-age') + 1] 
    : '7d'; // Par défaut: races > 7 jours
  const limit = args.includes('--limit')
    ? parseInt(args[args.indexOf('--limit') + 1])
    : 100;
  
  if (args.includes('--help')) {
    console.log(`
Usage: node scripts/sync-racetime-finalize.js [options]

Options:
  --dry-run          Mode simulation
  --max-age <time>   Seulement races > time (default: 7d)
                     Format: 30d, 24h, 60m
  --limit <n>        Max races à traiter (default: 100)
  --help             Afficher cette aide
  
Examples:
  node scripts/sync-racetime-finalize.js
  node scripts/sync-racetime-finalize.js --max-age 30d
  node scripts/sync-racetime-finalize.js --dry-run --limit 10
`);
    process.exit(0);
  }
  
  const maxAge = parseMaxAge(maxAgeStr);
  if (maxAgeStr && !maxAge) {
    console.error(`Format --max-age invalide: ${maxAgeStr}`);
    console.error('Format attendu: 30d, 24h, 60m');
    process.exit(1);
  }
  
  console.log('🔧 Finalisation Racetime\n');
  
  try {
    await connectDB();
    
    const stats = await finalizeInProgressRaces({
      dryRun,
      maxAge,
      limit
    });
    
    console.log('\n════════════════════════════════════');
    console.log(`Vérifiées: ${stats.checked}`);
    console.log(`Mises à jour: ${stats.updated}`);
    console.log(`Sans changement: ${stats.noChange}`);
    console.log(`Erreurs: ${stats.errors}`);
    console.log('════════════════════════════════════');
    
  } catch (error) {
    console.error('\n❌ Erreur:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

main();
