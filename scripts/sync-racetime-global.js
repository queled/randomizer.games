#!/usr/bin/env node
/**
 * Sync Racetime Global
 * 
 * Récupère les courses depuis racetime.gg en partant des races globales.
 * Cette approche est plus efficace que de parcourir jeu par jeu.
 * 
 * Features:
 * - Récupère les races récentes/en cours depuis l'API globale
 * - Met à jour automatiquement les races en cours
 * - Pas de limite de temps pour les syncs complètes
 * 
 * Usage:
 *   node scripts/sync-racetime-global.js                    # Races récentes (2 pages)
 *   node scripts/sync-racetime-global.js --full             # Sync complète d'un jeu
 *   node scripts/sync-racetime-global.js --game ootr        # Un seul jeu (toutes les pages)
 *   node scripts/sync-racetime-global.js --max-pages 100    # Limiter les pages
 *   node scripts/sync-racetime-global.js --no-limit         # Pas de limite de pages
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const connectDB = require('../config/database');
const { Game, Race } = require('../models');
const racetimeAPI = require('../services/racetime');

// Configuration
const RATE_LIMIT_MS = parseInt(process.env.RACETIME_RATE_LIMIT_MS) || 1500;
const DEFAULT_MAX_PAGES = 2; // Pour sync incrémentale rapide

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Récupérer les races en cours et récentes depuis l'API globale
 */
async function syncGlobalRaces(options = {}) {
  const { maxPages = DEFAULT_MAX_PAGES } = options;
  
  console.log('\n📡 Récupération des races globales...');
  
  const stats = { newRaces: 0, updatedRaces: 0, errors: 0, categories: new Set() };
  
  // Récupérer les slugs des jeux actifs (principal + additionnels)
  const activeGames = await Game.find({
    'integrations.racetime.enabled': true,
    enabled: { $ne: false }
  }).select('integrations.racetime.gameSlug integrations.racetime.gameSlugs').lean();
  
  const activeSlugs = new Set();
  for (const game of activeGames) {
    const primary = game.integrations?.racetime?.gameSlug;
    if (primary) activeSlugs.add(primary);
    
    const additional = game.integrations?.racetime?.gameSlugs || [];
    for (const slug of additional) {
      activeSlugs.add(slug);
    }
  }
  
  console.log(`  ${activeSlugs.size} slugs racetime actifs`);
  console.log(`  Slugs: ${Array.from(activeSlugs).join(', ')}`);
  
  let page = 1;
  let hasMore = true;
  
  while (hasMore && page <= maxPages) {
    try {
      await sleep(RATE_LIMIT_MS);
      
      // Appeler l'API globale des races
      const response = await require('axios').get('https://racetime.gg/races/data', {
        params: { show_entrants: true, page }
      });
      
      const races = response.data?.races || [];
      console.log(`  📊 Page ${page}: ${races.length} races`);
      
      if (races.length === 0) {
        hasMore = false;
        break;
      }
      
      for (const raceData of races) {
        const categorySlug = raceData.category?.slug;
        
        // Ignorer les catégories qui ne sont pas dans nos jeux actifs
        if (!activeSlugs.has(categorySlug)) {
          continue;
        }
        
        stats.categories.add(categorySlug);
        
        try {
          const formattedRace = racetimeAPI.formatRace(raceData);
          if (!formattedRace) continue;
          
          const raceUrl = formattedRace.url;
          
          // Vérifier si la course existe déjà
          const existingRace = await Race.findOne({ url: raceUrl });
          
          if (existingRace) {
            // Mettre à jour si le statut a changé
            if (existingRace.status !== formattedRace.status) {
              await Race.updateOne({ url: raceUrl }, {
                $set: {
                  status: formattedRace.status,
                  endedAt: formattedRace.endedAt,
                  entrants: formattedRace.entrants.map(e => ({
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
              name: formattedRace.name,
              category: categorySlug,
              url: raceUrl,
              status: formattedRace.status,
              goal: formattedRace.goal,
              info: formattedRace.info,
              startedAt: formattedRace.startedAt,
              endedAt: formattedRace.endedAt,
              recordable: formattedRace.recordable,
              entrants: formattedRace.entrants.map(e => ({
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
                externalId: formattedRace.name,
                url: `https://racetime.gg${raceUrl}`,
                importedAt: new Date()
              }
            });
            
            await newRace.save();
            stats.newRaces++;
          }
        } catch (err) {
          console.error(`  ❌ Erreur: ${err.message}`);
          stats.errors++;
        }
      }
      
      page++;
      
    } catch (err) {
      console.error(`  ❌ Erreur page ${page}: ${err.message}`);
      stats.errors++;
      break;
    }
  }
  
  return stats;
}

/**
 * Sync complet d'un jeu spécifique (toutes les pages)
 */
async function syncGameComplete(gameSlug, options = {}) {
  const { maxPages = Infinity, noLimit = false } = options;
  const effectiveMaxPages = noLimit ? Infinity : maxPages;
  
  console.log(`\n📡 Sync complète du jeu: ${gameSlug}`);
  if (effectiveMaxPages === Infinity) {
    console.log('  ⚠️  Mode sans limite - peut prendre du temps!');
  } else {
    console.log(`  Max pages: ${effectiveMaxPages}`);
  }
  
  const stats = { newRaces: 0, updatedRaces: 0, errors: 0, pages: 0 };
  
  let page = 1;
  let hasMore = true;
  let emptyPages = 0;
  
  while (hasMore && page <= effectiveMaxPages) {
    try {
      await sleep(RATE_LIMIT_MS);
      
      const result = await racetimeAPI.getPastRaces(gameSlug, page);
      stats.pages = page;
      
      if (!result.races || result.races.length === 0) {
        emptyPages++;
        if (emptyPages >= 3) {
          console.log(`  ℹ️  ${emptyPages} pages vides consécutives, arrêt.`);
          break;
        }
        page++;
        continue;
      }
      
      emptyPages = 0;
      console.log(`  📊 Page ${page}: ${result.races.length} courses`);
      
      for (const raceData of result.races) {
        const raceUrl = raceData.url;
        
        try {
          const existingRace = await Race.findOne({ url: raceUrl });
          
          if (existingRace) {
            // Mettre à jour
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
          } else {
            const newRace = new Race({
              name: raceData.name,
              category: gameSlug,
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
          if (err.code === 11000) {
            // Duplicate key - race already exists, skip
            continue;
          }
          console.error(`  ❌ Erreur: ${err.message}`);
          stats.errors++;
        }
      }
      
      if (!result.hasNext) {
        console.log(`  ℹ️  Plus de pages disponibles.`);
        break;
      }
      
      page++;
      
      // Afficher un résumé toutes les 50 pages
      if (page % 50 === 0) {
        console.log(`  📈 Progression: ${stats.newRaces} nouvelles, ${stats.updatedRaces} mises à jour (page ${page})`);
      }
      
    } catch (err) {
      console.error(`  ❌ Erreur page ${page}: ${err.message}`);
      stats.errors++;
      
      // Attendre un peu plus en cas d'erreur (rate limiting?)
      await sleep(RATE_LIMIT_MS * 2);
    }
  }
  
  // Mettre à jour la date de dernière sync
  await Game.updateOne(
    { 'integrations.racetime.gameSlug': gameSlug },
    { $set: { 'integrations.racetime.lastSync': new Date() } }
  );
  
  return stats;
}

async function main() {
  const args = process.argv.slice(2);
  
  const gameArg = args.includes('--game') ? args[args.indexOf('--game') + 1] : null;
  const maxPagesArg = args.includes('--max-pages') 
    ? parseInt(args[args.indexOf('--max-pages') + 1]) 
    : null;
  const full = args.includes('--full');
  const noLimit = args.includes('--no-limit');
  
  console.log('🏁 Sync Racetime Global\n');
  
  try {
    await connectDB();
    
    let stats;
    
    if (gameArg) {
      // Sync d'un jeu spécifique
      const maxPages = noLimit ? Infinity : (maxPagesArg || Infinity);
      stats = await syncGameComplete(gameArg, { maxPages, noLimit });
      
      console.log('\n════════════════════════════════════');
      console.log(`Jeu: ${gameArg}`);
      console.log(`Pages parcourues: ${stats.pages}`);
      console.log(`Nouvelles races: ${stats.newRaces}`);
      console.log(`Mises à jour: ${stats.updatedRaces}`);
      console.log(`Erreurs: ${stats.errors}`);
      console.log('════════════════════════════════════');
    } else {
      // Sync globale
      const maxPages = maxPagesArg || DEFAULT_MAX_PAGES;
      stats = await syncGlobalRaces({ maxPages });
      
      console.log('\n════════════════════════════════════');
      console.log(`Catégories actives: ${stats.categories.size}`);
      console.log(`Nouvelles races: ${stats.newRaces}`);
      console.log(`Mises à jour: ${stats.updatedRaces}`);
      console.log(`Erreurs: ${stats.errors}`);
      console.log('════════════════════════════════════');
    }
    
  } catch (error) {
    console.error('\n❌ Erreur:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

main();
