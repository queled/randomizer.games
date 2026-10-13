#!/usr/bin/env node
/**
 * Enrichir les jeux avec leurs catégories Twitch
 * 
 * Ce script cherche les catégories Twitch correspondantes pour chaque jeu
 * en utilisant le nom du jeu officiel.
 * 
 * Usage:
 *   node scripts/enrich-twitch.js                  # Enrichir tous les jeux
 *   node scripts/enrich-twitch.js --dry-run        # Mode simulation
 *   node scripts/enrich-twitch.js --force          # Forcer la mise à jour
 *   node scripts/enrich-twitch.js --ids alttp,ootr # Enrichir certains jeux
 * 
 * Variables d'environnement requises:
 *   TWITCH_CLIENT_ID     - Client ID de l'application Twitch
 *   TWITCH_CLIENT_SECRET - Client Secret de l'application Twitch
 */

const path = require('path');
const fs = require('fs');
const axios = require('axios');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const connectDB = require('../config/database');
const { Game } = require('../models');

// Configuration
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const RATE_LIMIT_MS = 100; // Twitch est assez permissif

let accessToken = null;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Obtenir un token d'accès Twitch
 */
async function getTwitchAccessToken() {
  if (accessToken) return accessToken;
  
  console.log('🔐 Authentification Twitch...');
  
  const response = await axios.post('https://id.twitch.tv/oauth2/token', null, {
    params: {
      client_id: TWITCH_CLIENT_ID,
      client_secret: TWITCH_CLIENT_SECRET,
      grant_type: 'client_credentials'
    }
  });
  
  accessToken = response.data.access_token;
  console.log('  ✓ Token obtenu');
  
  return accessToken;
}

/**
 * Rechercher une catégorie Twitch par nom
 */
async function searchTwitchCategory(gameName) {
  const token = await getTwitchAccessToken();
  
  try {
    // D'abord essayer une recherche exacte
    const exactResponse = await axios.get('https://api.twitch.tv/helix/games', {
      headers: {
        'Client-ID': TWITCH_CLIENT_ID,
        'Authorization': `Bearer ${token}`
      },
      params: {
        name: gameName
      }
    });
    
    if (exactResponse.data.data && exactResponse.data.data.length > 0) {
      return exactResponse.data.data[0];
    }
    
    // Sinon faire une recherche par mot-clé
    const searchResponse = await axios.get('https://api.twitch.tv/helix/search/categories', {
      headers: {
        'Client-ID': TWITCH_CLIENT_ID,
        'Authorization': `Bearer ${token}`
      },
      params: {
        query: gameName,
        first: 5
      }
    });
    
    if (searchResponse.data.data && searchResponse.data.data.length > 0) {
      // Prendre le premier résultat
      return searchResponse.data.data[0];
    }
    
    return null;
  } catch (error) {
    if (error.response?.status === 401) {
      // Token expiré, le renouveler
      accessToken = null;
      return searchTwitchCategory(gameName);
    }
    throw error;
  }
}

function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function searchTwitchCategoryDetailed(gameName) {
  const token = await getTwitchAccessToken();

  try {
    const exactResponse = await axios.get('https://api.twitch.tv/helix/games', {
      headers: {
        'Client-ID': TWITCH_CLIENT_ID,
        'Authorization': `Bearer ${token}`
      },
      params: {
        name: gameName
      }
    });

    const exactData = exactResponse.data?.data || [];
    if (exactData.length > 0) {
      const first = exactData[0];
      return {
        category: first,
        confidence: normalizeName(first.name) === normalizeName(gameName) ? 'exact' : 'search',
        candidates: exactData.slice(0, 5)
      };
    }

    const searchResponse = await axios.get('https://api.twitch.tv/helix/search/categories', {
      headers: {
        'Client-ID': TWITCH_CLIENT_ID,
        'Authorization': `Bearer ${token}`
      },
      params: {
        query: gameName,
        first: 5
      }
    });

    const candidates = searchResponse.data?.data || [];
    if (candidates.length === 0) {
      return { category: null, confidence: 'none', candidates: [] };
    }

    const target = normalizeName(gameName);
    const exactCandidate = candidates.find(c => normalizeName(c.name) === target) || null;
    if (exactCandidate) {
      return {
        category: exactCandidate,
        confidence: 'exact',
        candidates
      };
    }

    return {
      category: candidates[0],
      confidence: 'doubtful',
      candidates
    };
  } catch (error) {
    if (error.response?.status === 401) {
      accessToken = null;
      return searchTwitchCategoryDetailed(gameName);
    }
    throw error;
  }
}

/**
 * Enrichir les jeux avec leurs catégories Twitch
 */
async function enrichTwitchCategories(options = {}) {
  const { dryRun = false, force = false, ids = null, safeOnly = false, reportPath = null } = options;
  
  console.log('\n📺 Enrichissement des catégories Twitch...');
  if (dryRun) console.log('  ⚠️  Mode simulation (dry-run)');
  
  // Récupérer les jeux à enrichir
  let query = { enabled: { $ne: false } };
  if (ids) {
    query.id = { $in: ids };
  }
  // Une catégorie validée à la main n'est jamais remplacée, même avec --force
  query['integrations.twitch.confidence'] = { $ne: 'manual' };
  if (!force) {
    // Ne pas ré-essayer ceux déjà marqués comme introuvables
    query['integrations.twitch.notFound'] = { $ne: true };
    // Compléter uniquement si des champs manquent
    query.$or = [
      { 'integrations.twitch.categoryId': { $exists: false } },
      { 'integrations.twitch.categoryName': { $exists: false } },
      { 'integrations.twitch.boxArtUrl': { $exists: false } },
      { 'integrations.twitch.enabled': { $ne: true } }
    ];
  }
  
  const games = await Game.find(query).sort({ name: 1 });
  console.log(`  ${games.length} jeux à enrichir`);
  
  const stats = { found: 0, notFound: 0, errors: 0 };
  const doubtful = [];
  
  for (const game of games) {
    await sleep(RATE_LIMIT_MS);
    
    // Noms à essayer pour la recherche
    const namesToTry = [
      game.official?.name,
      game.name,
      // Enlever "Randomizer" si présent
      game.name?.replace(/\s*randomizer\s*/i, '').trim(),
      game.official?.name?.replace(/\s*randomizer\s*/i, '').trim()
    ].filter(Boolean);
    
    // Dédupliquer
    const uniqueNames = [...new Set(namesToTry)];
    
    let foundCategory = null;
    let foundConfidence = 'none';
    let foundSearchName = null;
    let foundCandidates = [];
    
    for (const searchName of uniqueNames) {
      try {
        const result = await searchTwitchCategoryDetailed(searchName);
        if (result.category) {
          foundCategory = result.category;
          foundConfidence = result.confidence;
          foundSearchName = searchName;
          foundCandidates = result.candidates || [];
          break;
        }
      } catch (error) {
        console.error(`  ❌ Erreur recherche "${searchName}": ${error.message}`);
        stats.errors++;
      }
    }
    
    if (foundCategory) {
      const isDoubtful = foundConfidence !== 'exact';
      if (isDoubtful) {
        doubtful.push({
          id: game.id,
          gameName: game.name,
          searchedWith: foundSearchName,
          picked: {
            id: foundCategory.id,
            name: foundCategory.name
          },
          candidates: foundCandidates.map(c => ({ id: c.id, name: c.name }))
        });
      }

      if (safeOnly && isDoubtful) {
        console.log(`  ⚠️  ${game.id}: douteux → validation manuelle requise (proposé: ${foundCategory.name})`);
        stats.notFound++;
        continue;
      }

      if (dryRun) {
        console.log(`  📋 [DRY-RUN] ${game.id}: ${foundCategory.name} (${foundCategory.id}) [${foundConfidence}]`);
      } else {
        const twitch = game.integrations?.twitch || {};
        const updateSet = {
          'integrations.twitch.lastSync': new Date(),
          'integrations.twitch.notFound': false
        };

        if (force || !twitch.enabled) {
          updateSet['integrations.twitch.enabled'] = true;
        }
        if (force || !twitch.categoryId) {
          updateSet['integrations.twitch.categoryId'] = foundCategory.id;
        }
        if (force || !twitch.categoryName) {
          updateSet['integrations.twitch.categoryName'] = foundCategory.name;
        }
        if (force || !twitch.boxArtUrl) {
          updateSet['integrations.twitch.boxArtUrl'] = foundCategory.box_art_url;
        }
        if (force || !twitch.confidence) {
          updateSet['integrations.twitch.confidence'] = foundConfidence === 'exact' ? 'auto' : 'manual';
        }

        await Game.updateOne({ id: game.id }, { $set: updateSet });
        console.log(`  ✓ ${game.id}: ${foundCategory.name} (${foundCategory.id})`);
      }
      stats.found++;
    } else {
      if (dryRun) {
        console.log(`  📋 [DRY-RUN] ${game.id}: ❌ Pas trouvé (recherché: ${uniqueNames.join(', ')})`);
      } else {
        // Marquer comme non trouvé pour ne pas re-essayer
        await Game.updateOne({ id: game.id }, {
          $set: {
            'integrations.twitch.notFound': true,
            'integrations.twitch.lastSync': new Date()
          }
        });
        console.log(`  ✗ ${game.id}: Pas trouvé (${uniqueNames.join(', ')})`);
      }
      stats.notFound++;
    }
  }

  if (reportPath && doubtful.length > 0) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), doubtful }, null, 2), 'utf8');
    console.log(`\n📝 Rapport des cas douteux: ${reportPath}`);
  }
  
  console.log('\n════════════════════════════════════');
  console.log(`Trouvés: ${stats.found}`);
  console.log(`Non trouvés: ${stats.notFound}`);
  console.log(`Erreurs: ${stats.errors}`);
  console.log('════════════════════════════════════');
  
  return stats;
}

async function main() {
  const args = process.argv.slice(2);
  
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const idsIndex = args.indexOf('--ids');
  const ids = idsIndex > -1 && args[idsIndex + 1] 
    ? args[idsIndex + 1].split(',').map(s => s.trim())
    : null;
  const safeOnly = args.includes('--safe-only');

  const reportArgIndex = args.indexOf('--report');
  const reportPath = reportArgIndex > -1 && args[reportArgIndex + 1]
    ? args[reportArgIndex + 1]
    : path.join(__dirname, '..', 'reports', `twitch-doubtful-${Date.now()}.json`);
  
  if (args.includes('--help')) {
    console.log(`
Usage: node scripts/enrich-twitch.js [options]

Options:
  --dry-run     Mode simulation (ne modifie pas la BDD)
  --force       Forcer la mise à jour même si déjà renseigné
  --safe-only   N'applique que les correspondances exactes (les doutes vont dans un rapport)
  --ids <ids>   Liste d'IDs de jeux séparés par des virgules
  --report <p>  Chemin du rapport JSON des cas douteux

Variables d'environnement requises:
  TWITCH_CLIENT_ID
  TWITCH_CLIENT_SECRET
`);
    process.exit(0);
  }
  
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
    console.error('❌ Variables TWITCH_CLIENT_ID et TWITCH_CLIENT_SECRET requises');
    console.error('   Créez une application sur https://dev.twitch.tv/console');
    process.exit(1);
  }
  
  console.log('📺 Enrichissement Twitch\n');
  
  try {
    await connectDB();
    await enrichTwitchCategories({ dryRun, force, ids, safeOnly, reportPath });
    console.log('\n✅ Terminé');
    
  } catch (error) {
    console.error('\n❌ Erreur:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

main();
