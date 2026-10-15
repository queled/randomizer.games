#!/usr/bin/env node
/**
 * Check Rando-List Changes
 * 
 * Vérifie s'il y a eu des changements dans le repo rando-list depuis la dernière sync.
 * Utilisé par le workflow GitHub Actions pour décider si une synchronisation est nécessaire.
 * 
 * Output: JSON avec hasChanges (boolean) et newGames (array)
 * 
 * Usage:
 *   node scripts/check-rando-list-changes.js --commit <commit_hash>
 */

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const connectDB = require('../config/database');

async function main() {
  const args = process.argv.slice(2);
  const commitIndex = args.indexOf('--commit');
  const currentCommit = commitIndex !== -1 ? args[commitIndex + 1] : null;
  
  if (!currentCommit) {
    console.error('Usage: node check-rando-list-changes.js --commit <commit_hash>');
    process.exit(1);
  }
  
  try {
    await connectDB();
    
    // Récupérer le dernier commit synchronisé depuis le cache
    const col = mongoose.connection.collection('rando_list_cache');
    const metadata = await col.findOne({ _id: '_metadata' });
    
    const result = {
      hasChanges: true,
      newGames: [],
      previousCommit: metadata?.commitHash || null,
      currentCommit
    };
    
    // Si le commit est le même, pas de changement
    if (metadata?.commitHash === currentCommit) {
      result.hasChanges = false;
      console.log(JSON.stringify(result));
      return;
    }
    
    // Détecter les nouveaux jeux (comparaison avec le cache existant)
    if (metadata) {
      const TMP_DIR = process.env.RANDO_LIST_DIR || path.join(__dirname, 'tmp', 'rando-list');
      const SERIES_DIR = path.join(TMP_DIR, 'src', 'series');
      
      if (fs.existsSync(SERIES_DIR)) {
        const yaml = require('js-yaml');
        
        // Récupérer tous les randomizers actuellement en cache
        const cachedRandomizers = new Set();
        const allCached = await col.find({ _id: { $ne: '_metadata' } }).toArray();
        
        for (const series of allCached) {
          if (series.randomizers) {
            for (const rando of series.randomizers) {
              if (rando.identifier) {
                cachedRandomizers.add(rando.identifier);
              }
            }
          }
        }
        
        // Parser les fichiers actuels et trouver les nouveaux
        const seriesFiles = fs.readdirSync(SERIES_DIR)
          .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
        
        for (const file of seriesFiles) {
          try {
            const filePath = path.join(SERIES_DIR, file);
            const content = fs.readFileSync(filePath, 'utf8');
            const data = yaml.load(content);
            
            if (data?.randomizers) {
              for (const rando of data.randomizers) {
                if (rando.identifier && !cachedRandomizers.has(rando.identifier)) {
                  result.newGames.push(rando.identifier);
                }
              }
            }
          } catch (err) {
            // Ignorer les fichiers invalides
          }
        }
      }
    }
    
    console.log(JSON.stringify(result));
    
  } catch (error) {
    console.error('Error:', error.message);
    // En cas d'erreur, on considère qu'il y a des changements
    console.log(JSON.stringify({ hasChanges: true, newGames: [], error: error.message }));
  } finally {
    await mongoose.disconnect();
  }
}

main();
