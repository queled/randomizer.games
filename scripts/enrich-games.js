#!/usr/bin/env node
/**
 * Enrich Games Data
 * 
 * Ce script enrichit les jeux existants avec les données de:
 * - speedrun.com (plateformes, date de sortie, images)
 * - racetime.gg (vérification de disponibilité)
 * 
 * IMPORTANT: 
 * - N'écrase JAMAIS les données confidence='manual'
 * - Mode --dry-run par défaut
 * - Enrichit uniquement les jeux avec intégrations.*.enabled=true
 * 
 * Usage:
 *   node scripts/enrich-games.js --dry-run
 *   node scripts/enrich-games.js --speedrun
 *   node scripts/enrich-games.js --racetime
 *   node scripts/enrich-games.js --all
 *   node scripts/enrich-games.js --game=alttp
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const connectDB = require('../config/database');
const { Game } = require('../models');
const speedrunAPI = require('../services/speedrun');
const racetimeAPI = require('../services/racetime');

async function enrichFromSpeedrun(game, dryRun = true) {
  const integration = game.integrations?.speedrun;
  
  if (!integration?.enabled) {
    return { status: 'skipped', reason: 'speedrun not enabled' };
  }
  
  // Ne pas écraser les données manuelles
  if (integration.confidence === 'manual') {
    console.log(`  ⏭️  [speedrun] ${game.id} - données manuelles, skip enrichissement`);
    return { status: 'skipped', reason: 'manual confidence' };
  }
  
  try {
    let srcGame = null;
    
    // Si on a un ID, récupérer directement
    if (integration.gameId) {
      srcGame = await speedrunAPI.getGameById(integration.gameId);
      if (srcGame) {
        srcGame = speedrunAPI.formatGame(srcGame);
      }
    }
    
    // Sinon, chercher par nom
    if (!srcGame) {
        const result = await speedrunAPI.findBestMatch(game.name, game.randomizer?.shortName || game.shortName);
      if (result.game) {
        srcGame = result.game;
      }
    }
    
    if (!srcGame) {
      console.log(`  ⚠️  [speedrun] ${game.id} - aucun match trouvé`);
      return { status: 'not_found' };
    }
    
    // Préparer les mises à jour (sans écraser les valeurs existantes)
    const updates = {};
    
    // Plateformes (seulement si vide)
    if ((!game.platforms || game.platforms.length === 0) && srcGame.platforms?.length > 0) {
      updates.platforms = srcGame.platforms;
    }
    
    // Date de sortie (seulement si vide)
    if (!game.official?.releaseDate && srcGame.releaseDate) {
      updates['official.releaseDate'] = srcGame.releaseDate;
    }
    
    // Nom officiel (seulement si vide)
    if (!game.official?.name && srcGame.name) {
      updates['official.name'] = srcGame.name;
    }
    
    // Images (seulement si vide)
    if (!game.image && srcGame.assets?.coverMedium) {
      updates.image = srcGame.assets.coverMedium;
    }
    if (!game.logo && srcGame.assets?.logo) {
      updates.logo = srcGame.assets.logo;
    }
    
    // Mettre à jour l'intégration
    updates['integrations.speedrun.gameId'] = srcGame.id;
    updates['integrations.speedrun.weblink'] = srcGame.weblink;
    updates['integrations.speedrun.lastSync'] = new Date();
    
    if (Object.keys(updates).length === 0) {
      console.log(`  ✓ [speedrun] ${game.id} - déjà à jour`);
      return { status: 'unchanged' };
    }
    
    if (dryRun) {
      console.log(`  📋 [DRY-RUN][speedrun] ${game.id} - enrichirait:`, Object.keys(updates));
    } else {
      await Game.updateOne({ id: game.id }, { $set: updates });
      console.log(`  ✨ [speedrun] ${game.id} - enrichi avec:`, Object.keys(updates));
    }
    
    return { status: 'enriched', updates };
    
  } catch (error) {
    console.error(`  ❌ [speedrun] ${game.id} - erreur:`, error.message);
    return { status: 'error', error: error.message };
  }
}

async function enrichFromRacetime(game, dryRun = true) {
  const integration = game.integrations?.racetime;
  
  if (!integration?.enabled) {
    return { status: 'skipped', reason: 'racetime not enabled' };
  }
  
  // Ne pas écraser les données manuelles
  if (integration.confidence === 'manual') {
    console.log(`  ⏭️  [racetime] ${game.id} - données manuelles, skip enrichissement`);
    return { status: 'skipped', reason: 'manual confidence' };
  }
  
  try {
    const slug = integration.gameSlug;
    if (!slug) {
      return { status: 'skipped', reason: 'no slug' };
    }
    
    const categoryInfo = await racetimeAPI.getCategoryInfo(slug);
    
    if (!categoryInfo) {
      console.log(`  ⚠️  [racetime] ${game.id} - catégorie '${slug}' non trouvée`);
      return { status: 'not_found' };
    }
    
    const updates = {
      'integrations.racetime.gameName': categoryInfo.name,
      'integrations.racetime.lastSync': new Date()
    };
    
    if (dryRun) {
      console.log(`  📋 [DRY-RUN][racetime] ${game.id} - vérifié: ${categoryInfo.name}`);
    } else {
      await Game.updateOne({ id: game.id }, { $set: updates });
      console.log(`  ✓ [racetime] ${game.id} - vérifié: ${categoryInfo.name}`);
    }
    
    return { status: 'verified', categoryInfo };
    
  } catch (error) {
    console.error(`  ❌ [racetime] ${game.id} - erreur:`, error.message);
    return { status: 'error', error: error.message };
  }
}

async function enrichGames(options = {}) {
  const { 
    dryRun = true, 
    speedrun = false, 
    racetime = false, 
    gameId = null 
  } = options;
  
  const enrichAll = !speedrun && !racetime;
  
  // Construire la query
  const query = gameId ? { id: gameId } : { enabled: { $ne: false } };
  
  const games = await Game.find(query);
  console.log(`\n🎮 ${games.length} jeu(x) à traiter\n`);
  
  const stats = {
    speedrun: { enriched: 0, skipped: 0, errors: 0, notFound: 0 },
    racetime: { verified: 0, skipped: 0, errors: 0, notFound: 0 }
  };
  
  for (const game of games) {
    console.log(`\n📦 ${game.id} - ${game.name}`);
    
    if (speedrun || enrichAll) {
      const result = await enrichFromSpeedrun(game, dryRun);
      if (result.status === 'enriched') stats.speedrun.enriched++;
      else if (result.status === 'skipped' || result.status === 'unchanged') stats.speedrun.skipped++;
      else if (result.status === 'error') stats.speedrun.errors++;
      else if (result.status === 'not_found') stats.speedrun.notFound++;
    }
    
    if (racetime || enrichAll) {
      const result = await enrichFromRacetime(game, dryRun);
      if (result.status === 'verified') stats.racetime.verified++;
      else if (result.status === 'skipped') stats.racetime.skipped++;
      else if (result.status === 'error') stats.racetime.errors++;
      else if (result.status === 'not_found') stats.racetime.notFound++;
    }
    
    // Rate limiting entre les jeux
    await new Promise(r => setTimeout(r, 200));
  }
  
  return stats;
}

function printStats(stats, dryRun) {
  console.log('\n' + '='.repeat(50));
  console.log(dryRun ? '📋 RÉSUMÉ (DRY-RUN)' : '📋 RÉSUMÉ');
  console.log('='.repeat(50));
  
  console.log('\n🏃 speedrun.com:');
  console.log(`  ✨ Enrichis:   ${stats.speedrun.enriched}`);
  console.log(`  ⏭️  Ignorés:    ${stats.speedrun.skipped}`);
  console.log(`  ⚠️  Non trouvés: ${stats.speedrun.notFound}`);
  console.log(`  ❌ Erreurs:    ${stats.speedrun.errors}`);
  
  console.log('\n🏁 racetime.gg:');
  console.log(`  ✓ Vérifiés:   ${stats.racetime.verified}`);
  console.log(`  ⏭️  Ignorés:    ${stats.racetime.skipped}`);
  console.log(`  ⚠️  Non trouvés: ${stats.racetime.notFound}`);
  console.log(`  ❌ Erreurs:    ${stats.racetime.errors}`);
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--help')) {
    console.log(`
Usage: node enrich-games.js [options]

Options:
  --dry-run     Affiche ce qui serait fait sans modifier la BDD (défaut)
  --speedrun    Enrichir uniquement depuis speedrun.com
  --racetime    Vérifier uniquement sur racetime.gg
  --all         Enrichir depuis toutes les sources
  --game=<id>   Traiter uniquement le jeu spécifié
  --help        Affiche cette aide

Exemples:
  node scripts/enrich-games.js --dry-run
  node scripts/enrich-games.js --speedrun --game=alttp
  node scripts/enrich-games.js --all
`);
    process.exit(0);
  }
  
  const dryRun = !args.includes('--all') && !args.includes('--speedrun') && !args.includes('--racetime') || args.includes('--dry-run');
  const speedrun = args.includes('--speedrun') || args.includes('--all');
  const racetime = args.includes('--racetime') || args.includes('--all');
  const gameArg = args.find(a => a.startsWith('--game='));
  const gameId = gameArg ? gameArg.split('=')[1] : null;
  
  console.log('🎮 Enrichissement des jeux');
  console.log('Mode:', dryRun ? 'DRY-RUN' : 'PRODUCTION');
  console.log('Sources:', speedrun && racetime ? 'toutes' : speedrun ? 'speedrun.com' : racetime ? 'racetime.gg' : 'toutes');
  if (gameId) console.log('Jeu:', gameId);
  
  try {
    await connectDB();
    const stats = await enrichGames({ dryRun, speedrun, racetime, gameId });
    printStats(stats, dryRun);
    
  } catch (error) {
    console.error('❌ Erreur fatale:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

main();
