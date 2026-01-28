#!/usr/bin/env node
/**
 * Sync Racetime Incremental
 * 
 * Récupère les nouvelles courses depuis racetime.gg de manière incrémentale.
 * Ce script est optimisé pour être exécuté fréquemment (toutes les 5 minutes).
 * 
 * Features:
 * - Ne récupère que les nouvelles courses depuis la dernière sync
 * - Respecte les rate limits de racetime.gg
 * - Supporte tous les jeux actifs ou un jeu spécifique
 * 
 * Usage:
 *   node scripts/sync-racetime-incremental.js              # Tous les jeux actifs
 *   node scripts/sync-racetime-incremental.js --game ootr  # Un seul jeu
 *   node scripts/sync-racetime-incremental.js --full       # Ignore le cache de date
 *   node scripts/sync-racetime-incremental.js --max-pages 5
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const connectDB = require('../config/database');
const { Game, Race } = require('../models');
const racetimeAPI = require('../services/racetime');

// Configuration
const RATE_LIMIT_MS = parseInt(process.env.RACETIME_RATE_LIMIT_MS) || 1500;
const DEFAULT_MAX_PAGES = 2;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function syncGameRaces(game, options = {}) {
  const { maxPages = DEFAULT_MAX_PAGES, full = false } = options;
  const slug = game.integrations?.racetime?.gameSlug;
  
  if (!slug) {
    return { slug: null, newRaces: 0, updatedRaces: 0, skipped: true, reason: 'no_slug' };
  }
  
  console.log(`\n📡 Syncing: ${slug} (${game.name})`);
  
  const stats = { slug, newRaces: 0, updatedRaces: 0, errors: 0 };
  
  // Récupérer la date de la dernière course enregistrée pour ce jeu
  let lastRaceDate = null;
  if (!full) {
    const lastRace = await Race.findOne({ category: slug })
      .sort({ startedAt: -1 })
      .select('startedAt')
      .lean();
    
    if (lastRace?.startedAt) {
      lastRaceDate = new Date(lastRace.startedAt);
      console.log(`  Dernière course: ${lastRaceDate.toISOString()}`);
    }
  }
  
  let page = 1;
  let shouldContinue = true;
  
  while (shouldContinue && page <= maxPages) {
    try {
      await sleep(RATE_LIMIT_MS);
      
      const result = await racetimeAPI.getPastRaces(slug, page);
      
      console.log(`  📊 Page ${page}: ${result.races?.length || 0} courses trouvées`);
      
      if (!result.races || result.races.length === 0) {
        console.log(`  ℹ️  Pas de courses supplémentaires trouvées`);
        break;
      }
      
      for (const raceData of result.races) {
        // racetime.url contient déjà le slug, ne pas le dupliquer
        const raceUrl = raceData.url && raceData.url.startsWith('/') ? raceData.url : `/${slug}${raceData.url || ''}`;
        
        // Vérifier si cette course est plus ancienne que la dernière connue
        if (lastRaceDate && raceData.startedAt) {
          const raceStart = new Date(raceData.startedAt);
          if (raceStart < lastRaceDate) {
            // On a atteint les courses déjà connues
            shouldContinue = false;
            break;
          }
        }
        
        try {
          // Vérifier si la course existe déjà
          const existingRace = await Race.findOne({ url: raceUrl });
          
          if (existingRace) {
            // Mettre à jour si le statut a changé ou si c'est une course récente
            if (existingRace.status !== raceData.status || 
                raceData.status === 'in_progress') {
              
              await Race.updateOne({ url: raceUrl }, {
                $set: {
                  status: raceData.status,
                  endedAt: raceData.endedAt,
                  entrants: raceData.entrants.map(e => ({
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
              });
              stats.updatedRaces++;
            }
          } else {
            // Nouvelle course
            const newRace = new Race({
              name: raceData.name,
              category: slug,
              url: raceUrl,
              status: raceData.status,
              goal: raceData.goal,
              info: raceData.info,
              startedAt: raceData.startedAt,
              endedAt: raceData.endedAt,
              recordable: raceData.recordable,
              entrants: raceData.entrants.map(e => ({
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
              })),
              source: {
                type: 'racetime',
                externalId: raceData.name,
                url: `https://racetime.gg${raceUrl}`,
                importedAt: new Date()
              }
            });
            
            await newRace.save();
            stats.newRaces++;
          }
        } catch (err) {
          console.error(`  ❌ Erreur race ${raceUrl}: ${err.message}`);
          stats.errors++;
        }
      }
      
      if (!result.hasNext) {
        break;
      }
      
      page++;
      
    } catch (err) {
      console.error(`  ❌ Erreur page ${page}: ${err.message}`);
      stats.errors++;
      break;
    }
  }
  
  console.log(`  ✓ ${stats.newRaces} nouvelles, ${stats.updatedRaces} mises à jour`);
  
  // Mettre à jour la date de dernière sync pour ce jeu
  await Game.updateOne(
    { id: game.id },
    { $set: { 'integrations.racetime.lastSync': new Date() } }
  );
  
  return stats;
}

async function main() {
  const args = process.argv.slice(2);
  
  const gameArg = args.includes('--game') ? args[args.indexOf('--game') + 1] : null;
  const maxPages = args.includes('--max-pages') 
    ? parseInt(args[args.indexOf('--max-pages') + 1]) 
    : DEFAULT_MAX_PAGES;
  const full = args.includes('--full');
  
  console.log('🏁 Sync Racetime Incremental\n');
  console.log(`Options: maxPages=${maxPages}, full=${full}, game=${gameArg || 'tous'}`);
  
  try {
    await connectDB();
    
    // Récupérer les jeux à synchroniser
    let query = {
      'integrations.racetime.enabled': true,
      enabled: { $ne: false }
    };
    
    if (gameArg) {
      query['integrations.racetime.gameSlug'] = gameArg;
    }
    
    const games = await Game.find(query);
    
    if (games.length === 0) {
      console.log('Aucun jeu à synchroniser');
      process.exit(0);
    }
    
    console.log(`\n${games.length} jeu(x) à synchroniser`);
    
    const allStats = {
      totalNew: 0,
      totalUpdated: 0,
      totalErrors: 0,
      games: []
    };
    
    for (const game of games) {
      const stats = await syncGameRaces(game, { maxPages, full });
      
      if (!stats.skipped) {
        allStats.totalNew += stats.newRaces;
        allStats.totalUpdated += stats.updatedRaces;
        allStats.totalErrors += stats.errors;
        allStats.games.push(stats);
      }
    }
    
    console.log('\n════════════════════════════════════');
    console.log(`Nouvelles races: ${allStats.totalNew}`);
    console.log(`Mises à jour: ${allStats.totalUpdated}`);
    console.log(`Erreurs: ${allStats.totalErrors}`);
    console.log('════════════════════════════════════');
    
  } catch (error) {
    console.error('\n❌ Erreur:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

main();
