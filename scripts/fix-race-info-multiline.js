#!/usr/bin/env node
/**
 * Fix Race Info - Retrieve complete multi-line info from racetime.gg
 * 
 * Problem: Database only stores first line of race info
 * Solution: Re-sync info field from racetime.gg API which has complete data
 * 
 * Usage:
 *   node scripts/fix-race-info-multiline.js                    # Fix all races
 *   node scripts/fix-race-info-multiline.js --game alttpr       # Fix specific game
 */

const path = require('path');
const mongoose = require('mongoose');
const axios = require('axios');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const connectDB = require('../config/database');
const { Race } = require('../models');
const racetimeAPI = require('../services/racetime');

const RATE_LIMIT_MS = parseInt(process.env.RACETIME_RATE_LIMIT_MS) || 1500;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fixRaceInfoMultiline() {
  console.log('\n🔧 Fixing race info to include all lines from racetime.gg...\n');
  
  try {
    await connectDB();
    
    // Get filter from args if provided
    const gameFilter = process.argv[2] === '--game' ? process.argv[3] : null;
    const query = gameFilter ? { category: gameFilter } : {};
    
    // Find races that need fixing (those with info from racetime)
    const racesToFix = await Race.find({
      ...query,
      'source.type': 'racetime',
      info: { $exists: true, $ne: '' }
    }).select('url category info').lean();
    
    console.log(`📋 Found ${racesToFix.length} races to check for multi-line info...\n`);
    
    let updated = 0;
    let noChange = 0;
    let errors = 0;
    
    for (const race of racesToFix) {
      try {
        // Parse URL to get category and race slug
        const urlParts = race.url.split('/').filter(p => p);
        if (urlParts.length < 2) {
          console.log(`⚠️  Skipping ${race.url} - invalid URL format`);
          continue;
        }
        
        const categorySlug = urlParts[0];
        const raceSlug = urlParts[1];
        
        // Fetch from racetime API
        const raceData = await racetimeAPI.getRace(categorySlug, raceSlug);
        await sleep(RATE_LIMIT_MS);
        
        if (!raceData || !raceData.info) {
          noChange++;
          continue;
        }
        
        // Check if info is different (more complete)
        if (raceData.info.length > race.info.length) {
          console.log(`✅ ${race.url}`);
          console.log(`   OLD: "${race.info.substring(0, 60)}..." (${race.info.length} chars, ${race.info.split('\n').length} lines)`);
          console.log(`   NEW: "${raceData.info.substring(0, 60)}..." (${raceData.info.length} chars, ${raceData.info.split('\n').length} lines)`);
          
          // Update the race
          await Race.findByIdAndUpdate(race._id || race.url, {
            info: raceData.info
          });
          updated++;
        } else {
          noChange++;
        }
      } catch (err) {
        console.error(`❌ ${race.url}: ${err.message}`);
        errors++;
      }
    }
    
    console.log(`\n✨ Fix complete!`);
    console.log(`  ✅ Updated: ${updated}`);
    console.log(`  ⏭️  No change needed: ${noChange}`);
    console.log(`  ❌ Errors: ${errors}`);
    
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Fatal error:', error.message);
    process.exit(1);
  }
}

fixRaceInfoMultiline();
