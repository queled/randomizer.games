#!/usr/bin/env node
/**
 * Backfill Race Info - Populate missing or incomplete multi-line info
 * 
 * Fetches info from racetime.gg API for races that may have truncated info
 */

const path = require('path');
const mongoose = require('mongoose');
const axios = require('axios');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const connectDB = require('../config/database');
const { Race } = require('../models');

const RATE_LIMIT_MS = parseInt(process.env.RACETIME_RATE_LIMIT_MS) || 1500;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Parse a race URL like "/alttpr/kind-mazerace-8178" to get category and slug
 */
function parseRaceUrl(url) {
  const parts = url.split('/').filter(p => p);
  if (parts.length < 2) return null;
  return {
    category: parts[0],
    slug: parts[1]
  };
}

async function backfillRaceInfo() {
  console.log('\n📡 Backfilling race info from racetime.gg...\n');
  
  try {
    await connectDB();
    
    // Find races from racetime that might have incomplete info
    const races = await Race.find({
      'source.type': 'racetime',
      url: { $regex: '^/(alttpr|ootr|mm|sm|smz3|ootmm|tww|tp|dk64|kh2fm|sotn)/' }
    }).select('_id url info category').lean();
    
    console.log(`Found ${races.length} racetime races to check\n`);
    
    let updated = 0;
    let skipped = 0;
    let errors = 0;
    
    for (let i = 0; i < races.length && i < 100; i++) {
      const race = races[i];
      const parsed = parseRaceUrl(race.url);
      
      if (!parsed) {
        console.log(`⚠️  [${i + 1}/${Math.min(races.length, 100)}] ${race.url} - Invalid URL format`);
        skipped++;
        continue;
      }
      
      try {
        // Fetch from racetime
        const response = await axios.get(
          `https://racetime.gg/${parsed.category}/${parsed.slug}/data`
        );
        
        const apiInfo = response.data.info || '';
        const currentInfo = race.info || '';
        
        if (apiInfo.length > currentInfo.length) {
          console.log(`✅ [${i + 1}/${Math.min(races.length, 100)}] ${race.url}`);
          console.log(`   Current: ${currentInfo.length} chars, ${currentInfo.split('\n').length} lines`);
          console.log(`   API has: ${apiInfo.length} chars, ${apiInfo.split('\n').length} lines`);
          
          // Update database
          await Race.updateOne({ _id: race._id }, { info: apiInfo });
          updated++;
        } else {
          skipped++;
        }
        
        await sleep(RATE_LIMIT_MS);
      } catch (err) {
        if (err.response?.status === 404) {
          // Race might be deleted or moved
          skipped++;
        } else {
          console.error(`❌ [${i + 1}] ${race.url}: ${err.message}`);
          errors++;
        }
        await sleep(RATE_LIMIT_MS);
      }
    }
    
    console.log(`\n✨ Backfill complete!`);
    console.log(`  ✅ Updated: ${updated}`);
    console.log(`  ⏭️  Skipped: ${skipped}`);
    console.log(`  ❌ Errors: ${errors}`);
    
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Fatal error:', error.message);
    process.exit(1);
  }
}

backfillRaceInfo();
