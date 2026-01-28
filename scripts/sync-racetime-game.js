#!/usr/bin/env node
/**
 * Sync Racetime Game
 * 
 * Synchronise les courses pour un jeu spécifique depuis racetime.gg.
 * Utile pour synchroniser un nouveau jeu détecté depuis rando-list.
 * 
 * Usage:
 *   node scripts/sync-racetime-game.js --game ootr
 *   node scripts/sync-racetime-game.js --game ootr --max-pages 100
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const connectDB = require('../config/database');
const { Game, Race } = require('../models');
const racetimeAPI = require('../services/racetime');

const RATE_LIMIT_MS = parseInt(process.env.RACETIME_RATE_LIMIT_MS) || 2000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function syncGameRaces(gameId, maxPages = 100) {
  // Chercher le jeu par ID ou slug racetime
  let game = await Game.findOne({ id: gameId });
  
  if (!game) {
    game = await Game.findOne({ 'integrations.racetime.gameSlug': gameId });
  }
  
  if (!game) {
    // Essayer de récupérer directement depuis racetime avec le slug
    console.log(`Jeu ${gameId} non trouvé en BDD, tentative directe sur racetime...`);
    return await syncDirectFromRacetime(gameId, maxPages);
  }
  
  const slug = game.integrations?.racetime?.gameSlug;
  
  if (!slug) {
    console.error(`Le jeu ${game.id} n'a pas de slug racetime configuré`);
    process.exit(1);
  }
  
  console.log(`🎮 Synchronisation: ${game.name} (${slug})`);
  
  const stats = { newRaces: 0, updatedRaces: 0, errors: 0 };
  let page = 1;
  
  while (page <= maxPages) {
    try {
      await sleep(RATE_LIMIT_MS);
      
      const result = await racetimeAPI.getPastRaces(slug, page);
      
      if (!result.races || result.races.length === 0) {
        break;
      }
      
      for (const raceData of result.races) {
        const raceUrl = `/${slug}${raceData.url || ''}`;
        
        try {
          const updateResult = await Race.updateOne(
            { url: raceUrl },
            {
              $set: {
                name: raceData.name,
                category: slug,
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
              }
            },
            { upsert: true }
          );
          
          if (updateResult.upsertedCount > 0) {
            stats.newRaces++;
          } else if (updateResult.modifiedCount > 0) {
            stats.updatedRaces++;
          }
        } catch (err) {
          console.error(`  ❌ Erreur: ${err.message}`);
          stats.errors++;
        }
      }
      
      process.stdout.write(`\r  Page ${page} - ${stats.newRaces} nouvelles, ${stats.updatedRaces} màj`);
      
      if (!result.hasNext) {
        break;
      }
      
      page++;
      
    } catch (err) {
      if (err.response?.status === 404) {
        console.log(`\n  ⚠️ Catégorie ${slug} non trouvée sur racetime.gg`);
        break;
      }
      console.error(`\n  ❌ Erreur page ${page}: ${err.message}`);
      stats.errors++;
      break;
    }
  }
  
  console.log(`\n\n✓ Terminé: ${stats.newRaces} nouvelles races, ${stats.updatedRaces} mises à jour`);
  
  // Mettre à jour la date de sync
  await Game.updateOne(
    { id: game.id },
    { $set: { 'integrations.racetime.lastSync': new Date() } }
  );
  
  return stats;
}

async function syncDirectFromRacetime(slug, maxPages) {
  console.log(`📡 Récupération directe depuis racetime.gg/${slug}`);
  
  // Vérifier si la catégorie existe
  try {
    const categoryInfo = await racetimeAPI.getCategoryInfo(slug);
    if (!categoryInfo) {
      console.error(`Catégorie ${slug} non trouvée sur racetime.gg`);
      process.exit(1);
    }
    console.log(`  Catégorie trouvée: ${categoryInfo.name}`);
  } catch (err) {
    console.error(`Erreur lors de la vérification de la catégorie: ${err.message}`);
    process.exit(1);
  }
  
  const stats = { newRaces: 0, updatedRaces: 0, errors: 0 };
  let page = 1;
  
  while (page <= maxPages) {
    try {
      await sleep(RATE_LIMIT_MS);
      
      const result = await racetimeAPI.getPastRaces(slug, page);
      
      if (!result.races || result.races.length === 0) {
        break;
      }
      
      for (const raceData of result.races) {
        const raceUrl = `/${slug}${raceData.url || ''}`;
        
        try {
          const updateResult = await Race.updateOne(
            { url: raceUrl },
            {
              $set: {
                name: raceData.name,
                category: slug,
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
              }
            },
            { upsert: true }
          );
          
          if (updateResult.upsertedCount > 0) {
            stats.newRaces++;
          } else if (updateResult.modifiedCount > 0) {
            stats.updatedRaces++;
          }
        } catch (err) {
          stats.errors++;
        }
      }
      
      process.stdout.write(`\r  Page ${page} - ${stats.newRaces} nouvelles`);
      
      if (!result.hasNext) break;
      page++;
      
    } catch (err) {
      console.error(`\n  ❌ Erreur: ${err.message}`);
      break;
    }
  }
  
  console.log(`\n\n✓ ${stats.newRaces} nouvelles races importées`);
  return stats;
}

async function main() {
  const args = process.argv.slice(2);
  
  if (!args.includes('--game')) {
    console.log('Usage: node sync-racetime-game.js --game <game_id_or_slug> [--max-pages n]');
    process.exit(1);
  }
  
  const gameId = args[args.indexOf('--game') + 1];
  const maxPages = args.includes('--max-pages') 
    ? parseInt(args[args.indexOf('--max-pages') + 1]) 
    : 100;
  
  try {
    await connectDB();
    await syncGameRaces(gameId, maxPages);
  } catch (error) {
    console.error('Erreur:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

main();
