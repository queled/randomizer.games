#!/usr/bin/env node
/**
 * Sync a specific racetime category and store with correct game mapping
 */
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const connectDB = require('./config/database');
const { Race, Game } = require('./models');
const axios = require('axios');

const RATE_LIMIT_MS = parseInt(process.env.RACETIME_RATE_LIMIT_MS) || 1500;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function syncCategory(category) {
  console.log(`\n📡 Synchronisation de la catégorie: ${category}`);
  
  let page = 1;
  let totalNew = 0;
  let totalUpdated = 0;
  
  try {
    while (page <= 5) {  // Limit to first 5 pages for testing
      console.log(`  Page ${page}...`);
      
      await sleep(RATE_LIMIT_MS);
      
      const response = await axios.get(`https://racetime.gg/${category}/races/data`, {
        params: { page }
      });
      
      const races = response.data?.races || [];
      if (races.length === 0) break;
      
      for (const raceData of races) {
        try {
          const raceUrl = `/${category}/${raceData.url}`;
          
          const query = { url: raceUrl };
          const update = {
            name: `${category}/${raceData.url}`,
            category,
            url: raceUrl,
            status: raceData.status,
            goal: raceData.goal,
            info: raceData.info,
            recordable: raceData.recordable,
            startedAt: raceData.started_at,
            endedAt: raceData.ended_at,
            entrants: raceData.entrants || [],
            source: {
              type: 'racetime',
              externalId: `${category}/${raceData.url}`,
              url: `https://racetime.gg/${category}/${raceData.url}`,
              importedAt: new Date()
            }
          };
          
          const result = await Race.findOneAndUpdate(query, update, { 
            upsert: true, 
            new: true,
            runValidators: false 
          });
          
          if (result.isNew || !result._id) {
            totalNew++;
          } else {
            totalUpdated++;
          }
        } catch (e) {
          console.error(`    ⚠️ Race error:`, e.message);
        }
      }
      
      page++;
    }
    
    console.log(`  ✅ Synced ${category}: ${totalNew} new, ${totalUpdated} updated`);
    return { totalNew, totalUpdated };
  } catch (e) {
    console.error(`  ❌ Error:`, e.message);
    return { totalNew: 0, totalUpdated: 0 };
  }
}

async function main() {
  try {
    await connectDB();
    
    // Sync alttpr-ladder
    const result = await syncCategory('alttpr-ladder');
    
    console.log(`\n📊 Résumé:`);
    console.log(`  Nouvelles races: ${result.totalNew}`);
    console.log(`  Mises à jour: ${result.totalUpdated}`);
    
    process.exit(0);
  } catch (e) {
    console.error('❌ Erreur:', e.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

main();
