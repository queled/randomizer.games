#!/usr/bin/env node
/**
 * Check Stuck Races
 * Analyser les races qui restent en in_progress ou open
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const connectDB = require('../config/database');
const { Race } = require('../models');
const racetimeAPI = require('../services/racetime');

const RATE_LIMIT_MS = 1500;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  try {
    await connectDB();
    
    console.log('\n📊 ANALYSE DES RACES STUCK\n');
    
    // Distribution des statuts
    const stats = await Race.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);
    
    console.log('Distribution des statuts:');
    stats.forEach(s => console.log(`  ${s._id}: ${s.count}`));
    
    // Races en in_progress
    const inProgressCount = await Race.countDocuments({ status: 'in_progress' });
    const openCount = await Race.countDocuments({ status: 'open' });
    const invitationalCount = await Race.countDocuments({ status: 'invitational' });
    
    console.log(`\n🔴 Races NON terminées: ${inProgressCount + openCount + invitationalCount}`);
    console.log(`   - in_progress: ${inProgressCount}`);
    console.log(`   - open: ${openCount}`);
    console.log(`   - invitational: ${invitationalCount}`);
    
    // Vérifier les 10 plus anciennes races en in_progress
    console.log('\n⏳ 10 plus anciennes races en in_progress:');
    const oldInProgress = await Race.find({ status: 'in_progress' })
      .select('url category startedAt')
      .sort({ startedAt: 1 })
      .limit(10)
      .lean();
    
    for (const race of oldInProgress) {
      const age = race.startedAt ? Math.floor((Date.now() - new Date(race.startedAt)) / 1000 / 60 / 60) : '?';
      console.log(`  ${race.url} - ${age}h ago - startedAt: ${race.startedAt ? race.startedAt.toISOString() : 'NULL'}`);
      
      // Vérifier le statut réel sur racetime
      try {
        const parts = race.url.split('/').filter(Boolean);
        const category = parts[0];
        const raceId = parts[1];
        
        await sleep(RATE_LIMIT_MS);
        const real = await racetimeAPI.getRace(category, raceId);
        
        if (real) {
          const realStatus = real.status;
          if (realStatus !== race.status) {
            console.log(`    ⚠️  MISMATCH! DB: ${race.status} vs RACETIME: ${realStatus}`);
          } else {
            console.log(`    ✓ Status correct: ${realStatus}`);
          }
        } else {
          console.log(`    ⚠️  Race not found on racetime`);
        }
      } catch (e) {
        console.log(`    ❌ Error checking racetime: ${e.message}`);
      }
    }
    
    // Vérifier les races avec startedAt NULL
    console.log('\n⚠️  Races avec startedAt NULL:');
    const nullStarted = await Race.find({ startedAt: null, status: { $in: ['in_progress', 'open'] } })
      .select('url category status')
      .limit(10)
      .lean();
    
    console.log(`  Total: ${await Race.countDocuments({ startedAt: null, status: { $in: ['in_progress', 'open'] } })}`);
    nullStarted.slice(0, 5).forEach(r => {
      console.log(`  ${r.url} (status: ${r.status})`);
    });
    
  } catch(e) {
    console.error('Error:', e);
  } finally {
    await mongoose.disconnect();
  }
}

main();
