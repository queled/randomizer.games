#!/usr/bin/env node
/**
 * Sync Racetime Global - Version Optimisée FIXE
 * 
 * PROBLÈME RÉSOLU: Les courses restaient en "in_progress" parce que:
 * 1. L'API /races/data ne retourne que les races TRÈS récentes
 * 2. Les anciennes courses stuck n'étaient JAMAIS finalisées
 * 3. Il n'y avait pas de scan par catégorie pour attraper les courses intermédiaires
 * 
 * SOLUTION:
 * - Récupérer races globales récentes (2 pages) via /races/data
 * - AUSSI scanner les premières 5 pages par catégorie pour races intermédiaires
 * - AGRESSIVEMENT finaliser courses anciennes (>24h) en in_progress
 * 
 * Usage:
 *   node scripts/sync-racetime-global.js                    # Mode normal (rapide)
 *   node scripts/sync-racetime-global.js --full             # Mode complet (thorough)
 *   node scripts/sync-racetime-global.js --finalize-only    # Seulement finalize stuck
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const connectDB = require('../config/database');
const { Game, Race } = require('../models');
const racetimeAPI = require('../services/racetime');

// Configuration
const RATE_LIMIT_MS = parseInt(process.env.RACETIME_RATE_LIMIT_MS) || 1500;
const DEFAULT_MAX_PAGES = 2; // Pour sync incrémentale rapide (2 pages globales)
const GAME_PAGES_TO_CHECK = 5; // Pages par jeu pour récupérer courses récentes

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
          let formattedRace = racetimeAPI.formatRace(raceData);
          
          // Si les entrants sont absents/incomplets, récupérer la race détaillée
          const hasEntrants = Array.isArray(formattedRace?.entrants) && formattedRace.entrants.length > 0;
          const isFinished = formattedRace?.status === 'finished';
          if ((!hasEntrants || !isFinished) && raceData.url) {
            const raceId = String(raceData.url).split('/').filter(Boolean).pop();
            if (raceId) {
              try {
                const detailedRace = await racetimeAPI.getRace(categorySlug, raceId);
                if (detailedRace) {
                  formattedRace = detailedRace;
                }
              } catch (detailError) {
                console.warn(`  ⚠️  Détails indisponibles pour ${raceData.url}: ${detailError.message}`);
              }
            }
          }
          if (!formattedRace) continue;
          
          const raceUrl = formattedRace.url;
          
          // Vérifier si la course existe déjà
          const existingRace = await Race.findOne({ url: raceUrl });
          
          if (existingRace) {
            // Mettre à jour si le statut a changé OU si la race est en cours
            const shouldRefreshEntrants = existingRace.status !== formattedRace.status
              || formattedRace.status !== 'finished';
            
            if (shouldRefreshEntrants) {
              await Race.updateOne({ url: raceUrl }, {
                $set: {
                  status: formattedRace.status,
                  startedAt: formattedRace.startedAt,
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
 * Synchroniser les premières pages de chaque catégorie active
 * pour attraper les courses récentes qui ne sont pas dans l'API globale
 */
async function syncPerGameRecent(options = {}) {
  console.log('\n🎮 Sync par catégorie (premières pages)...');
  
  const { maxPages = GAME_PAGES_TO_CHECK } = options;
  
  // Récupérer les slugs des jeux actifs
  const activeGames = await Game.find({
    'integrations.racetime.enabled': true,
    enabled: { $ne: false }
  }).select('id integrations.racetime.gameSlug integrations.racetime.gameSlugs').lean();
  
  const stats = { 
    newRaces: 0, 
    updatedRaces: 0, 
    errors: 0,
    gamesProcessed: 0
  };
  
  for (const game of activeGames) {
    const slugs = [game.integrations?.racetime?.gameSlug].filter(Boolean);
    if (game.integrations?.racetime?.gameSlugs) {
      slugs.push(...game.integrations.racetime.gameSlugs);
    }
    
    for (const slug of slugs) {
      try {
        let page = 1;
        let emptyPages = 0;
        let pageCount = 0;
        
        while (page <= maxPages) {
          try {
            await sleep(RATE_LIMIT_MS);
            
            const result = await racetimeAPI.getPastRaces(slug, page);
            
            if (!result.races || result.races.length === 0) {
              emptyPages++;
              if (emptyPages >= 2) {
                break;
              }
              page++;
              continue;
            }
            
            emptyPages = 0;
            pageCount++;
            
            for (const raceData of result.races) {
              const raceUrl = raceData.url;
              
              try {
                const existingRace = await Race.findOne({ url: raceUrl });
                
                if (existingRace) {
                  // Toujours mettre à jour les courses non finalisées
                  if (existingRace.status !== 'finished' && existingRace.status !== 'cancelled') {
                    await Race.updateOne({ url: raceUrl }, {
                      $set: {
                        status: raceData.status,
                        startedAt: raceData.startedAt,
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
                if (err.code !== 11000) {
                  stats.errors++;
                }
              }
            }
            
            if (!result.hasNext) {
              break;
            }
            
            page++;
            
          } catch (err) {
            if (err.response?.status !== 404) {
              stats.errors++;
            }
            break;
          }
        }
        
        if (pageCount > 0) {
          stats.gamesProcessed++;
        }
        
      } catch (err) {
        stats.errors++;
      }
    }
  }
  
  console.log(`  ✓ ${stats.gamesProcessed} catégories, ${stats.newRaces} nouvelles, ${stats.updatedRaces} màj`);
  return stats;
}

/**
 * Finaliser AGRESSIVEMENT les courses anciennes stuck en in_progress
 */
async function finializeStuckRaces(options = {}) {
  console.log('\n🔧 Finalisation des courses stuck (>24h)...');
  
  const maxAgeMs = 24 * 60 * 60 * 1000; // 24 heures
  const cutoffDate = new Date(Date.now() - maxAgeMs);
  
  // Chercher les races stuck
  const stuckRaces = await Race.find({
    status: { $in: ['in_progress', 'open', 'invitational'] },
    startedAt: { $lt: cutoffDate, $exists: true }
  })
    .select('url category startedAt status')
    .limit(200)
    .lean();
  
  console.log(`  Checking ${stuckRaces.length} stuck races...`);
  
  const stats = { updated: 0, errors: 0, notFound: 0 };
  
  for (const race of stuckRaces) {
    try {
      const parts = race.url.split('/').filter(Boolean);
      const category = parts[0];
      const raceId = parts[1];
      
      if (!category || !raceId) {
        continue;
      }
      
      await sleep(RATE_LIMIT_MS);
      
      const raceDetail = await racetimeAPI.getRace(category, raceId);
      
      if (!raceDetail) {
        await Race.updateOne(
          { url: race.url },
          { $set: { status: 'cancelled', endedAt: new Date() } }
        );
        stats.notFound++;
        continue;
      }
      
      const newStatus = raceDetail.status;
      if (newStatus !== race.status) {
        console.log(`  🔄 ${race.url}: ${race.status} → ${newStatus}`);
        
        await Race.updateOne({ url: race.url }, {
          $set: {
            status: newStatus,
            endedAt: raceDetail.endedAt,
            entrants: raceDetail.entrants.map(e => ({
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
        
        stats.updated++;
      }
    } catch (err) {
      stats.errors++;
    }
  }
  
  console.log(`  ✓ ${stats.updated} finalisées, ${stats.notFound} not found, ${stats.errors} erreurs`);
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
                startedAt: raceData.startedAt,
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
  
  const full = args.includes('--full');
  const finalizeOnly = args.includes('--finalize-only');
  
  console.log('🏁 Sync Racetime Global - FIXE\n');
  
  try {
    await connectDB();
    
    let allStats = {
      global: { newRaces: 0, updatedRaces: 0, errors: 0 },
      perGame: { newRaces: 0, updatedRaces: 0, errors: 0 },
      finalize: { updated: 0, errors: 0, notFound: 0 }
    };
    
    if (!finalizeOnly) {
      // 1. Sync globale (2-5 pages)
      console.log('ÉTAPE 1: Sync API globale');
      const globalStats = await syncGlobalRaces({ 
        maxPages: full ? 5 : DEFAULT_MAX_PAGES 
      });
      allStats.global = globalStats;
      
      // 2. Sync par catégorie (premières 5-10 pages)
      console.log('\nÉTAPE 2: Sync par catégorie (pages récentes)');
      const perGameStats = await syncPerGameRecent({ 
        maxPages: full ? 10 : GAME_PAGES_TO_CHECK 
      });
      allStats.perGame = perGameStats;
    }
    
    // 3. TOUJOURS finaliser les anciennes courses stuck
    console.log('\nÉTAPE 3: Finalisation des courses stuck');
    const finalizeStats = await finializeStuckRaces();
    allStats.finalize = finalizeStats;
    
    console.log('\n════════════════════════════════════');
    console.log('📊 RÉSUMÉ FINAL');
    console.log('════════════════════════════════════');
    console.log(`API Globale: ${allStats.global.newRaces} nouvelles, ${allStats.global.updatedRaces} màj`);
    console.log(`Par catégorie: ${allStats.perGame.newRaces} nouvelles, ${allStats.perGame.updatedRaces} màj`);
    console.log(`Finalisées: ${allStats.finalize.updated} courses`);
    console.log(`\nTotal erreurs: ${allStats.global.errors + allStats.perGame.errors + allStats.finalize.errors}`);
    console.log('════════════════════════════════════');
    
  } catch (error) {
    console.error('\n❌ Erreur:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

main();
