#!/usr/bin/env node
/**
 * Sync Racetime All
 * 
 * Synchronisation complète de toutes les races pour tous les jeux actifs.
 * Ce script est utilisé pour une synchronisation initiale ou une reconstruction complète.
 * 
 * ⚠️ ATTENTION: Ce script peut prendre beaucoup de temps et faire beaucoup de requêtes.
 * Utilisez-le avec précaution et respectez les rate limits de racetime.gg.
 * 
 * Usage:
 *   node scripts/sync-racetime-all.js --all              # Tous les jeux
 *   node scripts/sync-racetime-all.js --game ootr        # Un seul jeu
 *   node scripts/sync-racetime-all.js --max-pages 20     # Limite de pages
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const connectDB = require('../config/database');
const { Game, Race } = require('../models');
const racetimeAPI = require('../services/racetime');

// Configuration
const RATE_LIMIT_MS = parseInt(process.env.RACETIME_RATE_LIMIT_MS) || 2000;
const DEFAULT_MAX_PAGES = 50;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildRaceUrl(slug, rawRaceUrl) {
  const category = String(slug || '').trim().toLowerCase();
  if (!category) return null;

  let path = String(rawRaceUrl || '').trim();
  if (!path) return null;

  if (/^https?:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname || '';
    } catch (_) {
      path = '';
    }
  }

  path = path.split('?')[0].split('#')[0];
  path = path.replace(/\\/g, '/');
  path = path.replace(/\/+/g, '/');
  if (!path.startsWith('/')) path = `/${path}`;
  path = path.replace(/\/+$/, '');

  if (!path) return null;

  const lowerPath = path.toLowerCase();
  if (lowerPath.startsWith(`/${category}/`)) return lowerPath;

  return `/${category}/${path.replace(/^\/+/, '')}`.replace(/\/+/g, '/').toLowerCase();
}

async function syncAllRacesForGame(game, maxPages = DEFAULT_MAX_PAGES) {
  const slug = game.integrations?.racetime?.gameSlug;
  
  if (!slug) {
    console.log(`  ⚠️ ${game.id}: Pas de slug racetime`);
    return { newRaces: 0, updatedRaces: 0, skipped: true };
  }
  
  console.log(`\n🎮 ${game.name} (${slug})`);
  console.log('  Récupération de toutes les courses...');
  
  const stats = { newRaces: 0, updatedRaces: 0, errors: 0, pages: 0 };
  let page = 1;
  
  while (page <= maxPages) {
    try {
      await sleep(RATE_LIMIT_MS);
      
      const result = await racetimeAPI.getPastRaces(slug, page);
      
      if (!result.races || result.races.length === 0) {
        break;
      }
      
      stats.pages++;
      
      for (const raceData of result.races) {
        const raceUrl = buildRaceUrl(slug, raceData.url);
        if (!raceUrl) continue;
        
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
          console.error(`    ❌ Erreur race: ${err.message}`);
          stats.errors++;
        }
      }
      
      process.stdout.write(`\r  Page ${page}/${maxPages} - ${stats.newRaces} nouvelles, ${stats.updatedRaces} màj`);
      
      if (!result.hasNext) {
        break;
      }
      
      page++;
      
    } catch (err) {
      console.error(`\n  ❌ Erreur page ${page}: ${err.message}`);
      stats.errors++;
      break;
    }
  }
  
  console.log(`\n  ✓ ${stats.pages} pages, ${stats.newRaces} nouvelles, ${stats.updatedRaces} màj`);
  
  // Mettre à jour la date de dernière sync
  await Game.updateOne(
    { id: game.id },
    { $set: { 'integrations.racetime.lastSync': new Date() } }
  );
  
  return stats;
}

async function main() {
  const args = process.argv.slice(2);
  
  if (!args.includes('--all') && !args.includes('--game')) {
    console.log(`
Usage:
  node sync-racetime-all.js --all              # Synchroniser tous les jeux
  node sync-racetime-all.js --game <slug>      # Synchroniser un seul jeu
  
Options:
  --max-pages <n>   Nombre max de pages par jeu (défaut: 50)
`);
    process.exit(0);
  }
  
  const gameArg = args.includes('--game') ? args[args.indexOf('--game') + 1] : null;
  const maxPages = args.includes('--max-pages') 
    ? parseInt(args[args.indexOf('--max-pages') + 1]) 
    : DEFAULT_MAX_PAGES;
  
  console.log('🏁 Sync Racetime All - Synchronisation complète\n');
  console.log(`Options: maxPages=${maxPages}`);
  
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
    
    console.log(`${games.length} jeu(x) à synchroniser\n`);
    
    const allStats = {
      totalNew: 0,
      totalUpdated: 0,
      totalErrors: 0
    };
    
    for (const game of games) {
      const stats = await syncAllRacesForGame(game, maxPages);
      
      if (!stats.skipped) {
        allStats.totalNew += stats.newRaces;
        allStats.totalUpdated += stats.updatedRaces;
        allStats.totalErrors += stats.errors;
      }
    }
    
    console.log('\n════════════════════════════════════');
    console.log('RÉSUMÉ FINAL');
    console.log('════════════════════════════════════');
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
