#!/usr/bin/env node
/**
 * Sync Racetime Global - Version OPTIMISÉE pour < 5 minutes
 * 
 * STRATÉGIE SIMPLE ET EFFICACE:
 * 1. L'API /races/data retourne TOUTES les races actives (open, in_progress) en 1 appel
 * 2. On met à jour toutes les races actives de nos catégories
 * 3. Les races en BDD qui sont "in_progress" mais ABSENTES de l'API globale → terminées!
 * 4. On finalise ces races stuck (max 50/run pour rester < 5 min)
 * 
 * Usage:
 *   node scripts/sync-racetime-global.js                    # Mode normal (< 5 min)
 *   node scripts/sync-racetime-global.js --game <slug>      # Sync complète d'un jeu
 *   node scripts/sync-racetime-global.js --max-pages 100    # Limiter les pages (avec --game)
 */

const path = require('path');
const mongoose = require('mongoose');
const axios = require('axios');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const connectDB = require('../config/database');
const { Game, Race } = require('../models');
const racetimeAPI = require('../services/racetime');

// Configuration
const RATE_LIMIT_MS = parseInt(process.env.RACETIME_RATE_LIMIT_MS) || 1500;
const MAX_FINALIZE_PER_RUN = 50; // Max races à finaliser par run (pour rester < 5 min)

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * ÉTAPE 1: Récupérer TOUTES les races actives depuis l'API globale
 * L'API /races/data retourne toutes les races open/in_progress en 1 appel
 */
async function syncActiveRaces() {
  console.log('\n📡 Récupération des races actives...');
  
  // Récupérer les slugs des jeux actifs
  const activeGames = await Game.find({
    'integrations.racetime.enabled': true,
    enabled: { $ne: false }
  }).select('integrations.racetime.gameSlug integrations.racetime.gameSlugs').lean();
  
  const activeSlugs = new Set();
  for (const game of activeGames) {
    const primary = game.integrations?.racetime?.gameSlug;
    if (primary) activeSlugs.add(primary);
    const additional = game.integrations?.racetime?.gameSlugs || [];
    for (const slug of additional) activeSlugs.add(slug);
  }
  
  console.log(`  ${activeSlugs.size} catégories actives`);
  
  const stats = { newRaces: 0, updatedRaces: 0, errors: 0, activeUrls: new Set() };
  
  try {
    // UN SEUL APPEL pour toutes les races actives
    const response = await axios.get('https://racetime.gg/races/data', {
      params: { show_entrants: true }
    });
    
    const allRaces = response.data?.races || [];
    console.log(`  ${allRaces.length} races actives sur racetime.gg`);
    
    // Filtrer par nos catégories
    const ourRaces = allRaces.filter(r => activeSlugs.has(r.category?.slug));
    console.log(`  ${ourRaces.length} races dans nos catégories`);
    
    for (const raceData of ourRaces) {
      const categorySlug = raceData.category?.slug;
      const raceSlug = raceData.name?.split('/')[1] || raceData.url?.split('/').pop();
      const raceUrl = `/${categorySlug}/${raceSlug}`;
      
      stats.activeUrls.add(raceUrl);
      
      try {
        // Formatter la race
        let formattedRace = racetimeAPI.formatRace(raceData);
        
        // Toujours récupérer les détails complets pour avoir info complète multi-lignes
        // Les API globales peuvent retourner info tronquées
        if (raceSlug) {
          await sleep(RATE_LIMIT_MS);
          const detailedRace = await racetimeAPI.getRace(categorySlug, raceSlug);
          if (detailedRace) formattedRace = detailedRace;
        }
        
        if (!formattedRace) continue;
        
        const existingRace = await Race.findOne({ url: raceUrl });
        
        const entrantsData = (formattedRace.entrants || []).map(e => ({
          userId: e.user?.id || e.userId,
          userName: e.user?.name || e.userName,
          userDiscriminator: e.user?.discriminator || e.userDiscriminator,
          userUrl: e.user?.url || e.userUrl,
          status: e.status?.value || e.status,
          finishTime: e.finish_time || e.finishTime,
          finishTimeMs: e.finishTimeMs,
          finishedAt: e.finished_at || e.finishedAt,
          place: e.place,
          placeOrdinal: e.place_ordinal || e.placeOrdinal,
          comment: e.comment
        }));
        
        if (existingRace) {
          await Race.updateOne({ url: raceUrl }, {
            $set: {
              status: formattedRace.status?.value || formattedRace.status,
              startedAt: formattedRace.started_at || formattedRace.startedAt,
              endedAt: formattedRace.ended_at || formattedRace.endedAt,
              info: formattedRace.info,
              entrants: entrantsData
            }
          });
          stats.updatedRaces++;
        } else {
          const newRace = new Race({
            name: formattedRace.name,
            category: categorySlug,
            url: raceUrl,
            status: formattedRace.status?.value || formattedRace.status,
            goal: formattedRace.goal?.name || formattedRace.goal,
            info: formattedRace.info,
            startedAt: formattedRace.started_at || formattedRace.startedAt,
            endedAt: formattedRace.ended_at || formattedRace.endedAt,
            recordable: formattedRace.recordable,
            entrants: entrantsData,
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
        if (err.code !== 11000) {
          console.error(`  ❌ ${raceUrl}: ${err.message}`);
          stats.errors++;
        }
      }
    }
    
  } catch (err) {
    console.error(`  ❌ Erreur API globale: ${err.message}`);
    stats.errors++;
  }
  
  console.log(`  ✓ ${stats.newRaces} nouvelles, ${stats.updatedRaces} màj`);
  return stats;
}

/**
 * ÉTAPE 2: Finaliser les races qui ne sont plus dans l'API globale
 * Si une race est en BDD comme "in_progress" mais n'est plus dans /races/data,
 * c'est qu'elle est terminée sur racetime.gg
 */
async function finalizeCompletedRaces(activeUrls) {
  console.log('\n🔧 Finalisation des races terminées...');
  
  // Trouver les races en BDD qui sont "en cours" mais pas dans activeUrls
  const stuckRaces = await Race.find({
    status: { $in: ['in_progress', 'open', 'pending', 'invitational'] },
    url: { $nin: Array.from(activeUrls) }
  })
    .select('url category status startedAt')
    .sort({ startedAt: -1 })
    .limit(MAX_FINALIZE_PER_RUN)
    .lean();
  
  console.log(`  ${stuckRaces.length} races à vérifier (max ${MAX_FINALIZE_PER_RUN}/run)`);
  
  const stats = { finalized: 0, errors: 0 };
  
  for (const race of stuckRaces) {
    try {
      const parts = race.url.split('/').filter(Boolean);
      const category = parts[0];
      const raceId = parts[1];
      
      if (!category || !raceId) continue;
      
      await sleep(RATE_LIMIT_MS);
      
      const raceDetail = await racetimeAPI.getRace(category, raceId);
      
      if (!raceDetail) {
        // Race n'existe plus → marquer comme cancelled
        await Race.updateOne({ url: race.url }, { 
          $set: { status: 'cancelled', endedAt: new Date() } 
        });
        stats.finalized++;
        continue;
      }
      
      const newStatus = raceDetail.status?.value || raceDetail.status;
      
      if (newStatus !== race.status) {
        console.log(`  🔄 ${race.url}: ${race.status} → ${newStatus}`);
        
        const entrantsData = (raceDetail.entrants || []).map(e => ({
          userId: e.user?.id || e.userId,
          userName: e.user?.name || e.userName,
          userDiscriminator: e.user?.discriminator || e.userDiscriminator,
          userUrl: e.user?.url || e.userUrl,
          status: e.status?.value || e.status,
          finishTime: e.finish_time || e.finishTime,
          finishTimeMs: e.finishTimeMs,
          finishedAt: e.finished_at || e.finishedAt,
          place: e.place,
          placeOrdinal: e.place_ordinal || e.placeOrdinal,
          comment: e.comment
        }));
        
        await Race.updateOne({ url: race.url }, {
          $set: {
            status: newStatus,
            endedAt: raceDetail.ended_at || raceDetail.endedAt,
            entrants: entrantsData
          }
        });
        stats.finalized++;
      }
    } catch (err) {
      stats.errors++;
    }
  }
  
  console.log(`  ✓ ${stats.finalized} finalisées`);
  return stats;
}

/**
 * Sync complète d'un jeu spécifique (pour usage manuel)
 */
async function syncGameComplete(gameSlug, options = {}) {
  const { maxPages = Infinity } = options;
  
  console.log(`\n📡 Sync complète: ${gameSlug} (max ${maxPages === Infinity ? '∞' : maxPages} pages)`);
  
  const stats = { newRaces: 0, updatedRaces: 0, errors: 0, pages: 0 };
  let page = 1;
  
  while (page <= maxPages) {
    try {
      await sleep(RATE_LIMIT_MS);
      
      const result = await racetimeAPI.getPastRaces(gameSlug, page);
      
      if (!result.races?.length) break;
      
      stats.pages = page;
      console.log(`  Page ${page}: ${result.races.length} races`);
      
      for (const raceData of result.races) {
        const raceUrl = raceData.url;
        
        try {
          const existingRace = await Race.findOne({ url: raceUrl });
          
          const entrantsData = (raceData.entrants || []).map(e => ({
            userId: e.user?.id || e.userId,
            userName: e.user?.name || e.userName,
            userDiscriminator: e.user?.discriminator || e.userDiscriminator,
            userUrl: e.user?.url || e.userUrl,
            status: e.status?.value || e.status,
            finishTime: e.finish_time || e.finishTime,
            finishTimeMs: e.finishTimeMs,
            finishedAt: e.finished_at || e.finishedAt,
            place: e.place,
            placeOrdinal: e.place_ordinal || e.placeOrdinal,
            comment: e.comment
          }));
          
          if (existingRace) {
            await Race.updateOne({ url: raceUrl }, {
              $set: {
                status: raceData.status,
                startedAt: raceData.startedAt,
                endedAt: raceData.endedAt,
                entrants: entrantsData
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
              entrants: entrantsData,
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
          if (err.code !== 11000) stats.errors++;
        }
      }
      
      if (!result.hasNext) break;
      page++;
      
    } catch (err) {
      console.error(`  ❌ Page ${page}: ${err.message}`);
      break;
    }
  }
  
  console.log(`  ✓ ${stats.pages} pages, ${stats.newRaces} nouvelles, ${stats.updatedRaces} màj`);
  return stats;
}

async function main() {
  const args = process.argv.slice(2);
  
  const gameArg = args.includes('--game') ? args[args.indexOf('--game') + 1] : null;
  const maxPagesArg = args.includes('--max-pages') 
    ? parseInt(args[args.indexOf('--max-pages') + 1]) 
    : null;
  
  console.log('🏁 Sync Racetime Global\n');
  
  try {
    await connectDB();
    
    if (gameArg) {
      // Mode manuel: sync complète d'un jeu
      const game = await Game.findOne({ id: gameArg }).select('integrations.racetime').lean();
      
      if (!game?.integrations?.racetime?.gameSlug) {
        // Essayer avec le slug directement
        console.log(`Sync directe du slug: ${gameArg}`);
        await syncGameComplete(gameArg, { maxPages: maxPagesArg || Infinity });
      } else {
        const slugs = [game.integrations.racetime.gameSlug];
        if (game.integrations.racetime.gameSlugs) {
          slugs.push(...game.integrations.racetime.gameSlugs);
        }
        
        for (const slug of slugs) {
          await syncGameComplete(slug, { maxPages: maxPagesArg || Infinity });
        }
      }
      
    } else {
      // Mode automatique (cron): rapide et efficace
      
      // Étape 1: Récupérer toutes les races actives
      const activeStats = await syncActiveRaces();
      
      // Étape 2: Finaliser les races qui ne sont plus actives
      const finalizeStats = await finalizeCompletedRaces(activeStats.activeUrls);
      
      console.log('\n════════════════════════════════════');
      console.log('📊 RÉSUMÉ');
      console.log('════════════════════════════════════');
      console.log(`Nouvelles races: ${activeStats.newRaces}`);
      console.log(`Mises à jour: ${activeStats.updatedRaces}`);
      console.log(`Finalisées: ${finalizeStats.finalized}`);
      console.log(`Erreurs: ${activeStats.errors + finalizeStats.errors}`);
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
