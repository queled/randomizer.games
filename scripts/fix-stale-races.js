#!/usr/bin/env node
/**
 * Fix Stale Races
 * 
 * Corrige les races avec statut in_progress ou open qui sont anciennes
 * ou sans date de début. Re-vérifie avec l'API racetime.gg et met à jour.
 * 
 * Usage:
 *   node scripts/fix-stale-races.js
 *   node scripts/fix-stale-races.js --dry-run     # Afficher sans modifier
 *   node scripts/fix-stale-races.js --max-age 3d  # Races de plus de 3 jours
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const connectDB = require('../config/database');
const { Race } = require('../models');
const racetimeAPI = require('../services/racetime');

const RATE_LIMIT_MS = parseInt(process.env.RACETIME_RATE_LIMIT_MS) || 1500;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseMaxAge(str) {
  const match = str.match(/^(\d+)([dhm])$/);
  if (!match) throw new Error('Format invalide. Utilisez: 7d, 24h, 30m');
  
  const value = parseInt(match[1]);
  const unit = match[2];
  
  switch (unit) {
    case 'd': return value * 24 * 60 * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    case 'm': return value * 60 * 1000;
    default: throw new Error('Unité invalide');
  }
}

async function fixStaleRaces(options = {}) {
  const { dryRun = false, maxAge = '7d' } = options;
  
  const maxAgeMs = parseMaxAge(maxAge);
  const cutoffDate = new Date(Date.now() - maxAgeMs);
  
  console.log('\n🔧 Fix Stale Races');
  console.log(`   Max age: ${maxAge} (avant ${cutoffDate.toISOString()})`);
  console.log(`   Dry run: ${dryRun ? 'OUI' : 'NON'}\n`);
  
  // Trouver les races problématiques
  const query = {
    status: { $in: ['in_progress', 'open', 'invitational'] },
    $or: [
      { startedAt: null },
      { startedAt: { $lt: cutoffDate } }
    ]
  };
  
  console.log('🔍 Recherche des races problématiques...');
  const problematicRaces = await Race.find(query)
    .select('url status startedAt endedAt category name')
    .lean();
  
  console.log(`📊 ${problematicRaces.length} races à vérifier\n`);
  
  if (problematicRaces.length === 0) {
    console.log('✅ Aucune race problématique trouvée!');
    return { fixed: 0, errors: 0, skipped: 0 };
  }
  
  const stats = { fixed: 0, errors: 0, skipped: 0 };
  
  for (const race of problematicRaces) {
    const raceUrl = race.url;
    const parts = raceUrl.split('/').filter(Boolean);
    const category = parts[0];
    const raceId = parts[1];
    
    if (!category || !raceId) {
      console.log(`⚠️  URL invalide: ${raceUrl}`);
      stats.skipped++;
      continue;
    }
    
    try {
      await sleep(RATE_LIMIT_MS);
      
      console.log(`🔍 Vérification: ${raceUrl} (${race.status})`);
      
      // Récupérer les données actuelles depuis racetime.gg
      const currentData = await racetimeAPI.getRace(category, raceId);
      
      if (!currentData) {
        console.log(`   ⚠️  Race introuvable sur racetime.gg`);
        stats.skipped++;
        continue;
      }
      
      const oldStatus = race.status;
      const newStatus = currentData.status;
      
      if (oldStatus === newStatus && currentData.startedAt) {
        console.log(`   ✓ Statut OK (${newStatus}), mise à jour des dates`);
      } else {
        console.log(`   📝 ${oldStatus} → ${newStatus}`);
      }
      
      if (dryRun) {
        console.log(`   [DRY RUN] Aurait mis à jour`);
        stats.fixed++;
        continue;
      }
      
      // Mettre à jour la race
      await Race.updateOne(
        { url: raceUrl },
        {
          $set: {
            status: currentData.status,
            startedAt: currentData.startedAt,
            endedAt: currentData.endedAt,
            entrants: currentData.entrants.map(e => ({
              userId: e.user.id,
              userName: e.user.name,
              userDiscriminator: e.user.discriminator,
              userUrl: e.user.url,
              status: e.status,
              finishTime: e.finishTime,
              finishTimeMs: e.finishTimeMs,
              finishedAt: e.finishedAt,
              place: e.place,
              placeOrdinal: e.placeOrdinal,
              comment: e.comment
            }))
          }
        }
      );
      
      console.log(`   ✅ Mise à jour réussie`);
      stats.fixed++;
      
    } catch (error) {
      console.error(`   ❌ Erreur: ${error.message}`);
      stats.errors++;
      
      // Si 404, la race n'existe plus - on pourrait la marquer comme cancelled
      if (error.response && error.response.status === 404) {
        if (!dryRun) {
          await Race.updateOne(
            { url: raceUrl },
            { $set: { status: 'cancelled', endedAt: new Date() } }
          );
          console.log(`   🔧 Marquée comme cancelled`);
          stats.fixed++;
        }
      }
    }
  }
  
  return stats;
}

async function main() {
  const args = process.argv.slice(2);
  
  const dryRun = args.includes('--dry-run');
  const maxAgeArg = args.includes('--max-age') 
    ? args[args.indexOf('--max-age') + 1] 
    : '7d';
  
  try {
    await connectDB();
    
    const stats = await fixStaleRaces({ dryRun, maxAge: maxAgeArg });
    
    console.log('\n════════════════════════════════════');
    console.log(`Races corrigées: ${stats.fixed}`);
    console.log(`Erreurs: ${stats.errors}`);
    console.log(`Ignorées: ${stats.skipped}`);
    console.log('════════════════════════════════════\n');
    
  } catch (error) {
    console.error('\n❌ Erreur:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

main();
