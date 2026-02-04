#!/usr/bin/env node
/**
 * Script to link OoTR Standard Tournament Season 9 races to their tournament
 * 
 * This script:
 * 1. Deletes duplicate races with /ootr/ootr/ prefix
 * 2. Links the Preliminary Bracket race to its corresponding match
 * 3. Links qualification races to the tournament
 * 
 * Usage: node scripts/link-ootr-s9-races.js [--dry-run]
 */

const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/randomizer';

// Tournament ID for OoTR Season 9
const TOURNAMENT_ID = '69811a47855ce1115e6633cd';

// Race IDs provided by the user
const ALL_RACE_IDS = [
  // Preliminary Bracket match race
  '6982857e782e88c02d3cdd06',
  // Qualification races (some may be duplicates)
  '697e45cd54ee4c422cfe9ee3','697d63ff0c6df0b7a50c3093','697a9579f3e9dc0fafba25ef',
  '697a371bc4007e666ec8d2cf','697a3f91488e9546372a7a8a','697a371ec4007e666ec8d307',
  '697a371fc4007e666ec8d352','697a3f95488e9546372a7a91','697a371fc4007e666ec8d393',
  '697a3f95488e9546372a7a93','697a39f1928fcc86ea7603a9','697a3f9a488e9546372a7a9b',
  '697a39f6928fcc86ea76043c','697a3f9e488e9546372a7aa8','697a39fb928fcc86ea7604c7',
  '697a3fa3488e9546372a7ab7','697a39fb928fcc86ea760508','697a3fa4488e9546372a7ab8',
  '696b533f1ddd829b530e8c70','697a3fa7488e9546372a7abb','696b5234e0adab44ddb4eada',
  '697a3fac488e9546372a7ac4','696b5224fca1a50501dde790','697a3fac488e9546372a7ac6',
  '69664b77ba1d55b90b205340','697a3fb2488e9546372a7ad8','69664b6dea54789f06797129',
  '697a3fb6488e9546372a7ae2','69664b64813c3e15fa2d0e81','697a3fba488e9546372a7ae8',
  '69664b3d81ed81aaeef71b24','697a3fbf488e9546372a7afc','695a8ede5922ec8980b49179',
  '697a3fc8488e9546372a7b0e','695a8f905922ec8980b491b2','697a3fcc488e9546372a7b14'
];

// Preliminary Bracket race ID
const PRELIMINARY_RACE_ID = '6982857e782e88c02d3cdd06';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  
  if (dryRun) {
    console.log('🔍 DRY RUN MODE - No changes will be made\n');
  }
  
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to DB\n');
  
  const { Race, Tournament } = require('../models');
  
  // Load tournament
  const tournament = await Tournament.findById(TOURNAMENT_ID).lean();
  if (!tournament) {
    console.error('Tournament not found:', TOURNAMENT_ID);
    process.exit(1);
  }
  console.log('📋 Tournament:', tournament.name);
  console.log('   Matches:', tournament.matches?.length || 0);
  console.log('');
  
  // ========== STEP 1: Identify and delete duplicates ==========
  console.log('=== STEP 1: Identify duplicates ===\n');
  
  const races = [];
  for (const id of ALL_RACE_IDS) {
    const race = await Race.findById(id).lean();
    if (race) {
      races.push(race);
    }
  }
  
  // Find duplicates: races with /ootr/ootr/ prefix
  const duplicates = races.filter(r => r.url && r.url.startsWith('/ootr/ootr/'));
  const originals = races.filter(r => r.url && !r.url.startsWith('/ootr/ootr/'));
  
  console.log(`Found ${duplicates.length} duplicate races (with /ootr/ootr/ prefix)`);
  console.log(`Found ${originals.length} original races\n`);
  
  if (duplicates.length > 0) {
    console.log('Duplicates to delete:');
    for (const dup of duplicates) {
      const correctUrl = dup.url.replace('/ootr/ootr/', '/ootr/');
      const original = originals.find(o => o.url === correctUrl);
      console.log(`  ❌ ${dup._id} : ${dup.url}`);
      if (original) {
        console.log(`     → Original: ${original._id} : ${original.url}`);
      }
    }
    console.log('');
    
    if (!dryRun) {
      const deleteIds = duplicates.map(d => d._id);
      const result = await Race.deleteMany({ _id: { $in: deleteIds } });
      console.log(`✅ Deleted ${result.deletedCount} duplicate races\n`);
    } else {
      console.log('🔍 Would delete', duplicates.length, 'duplicate races\n');
    }
  }
  
  // ========== STEP 2: Link Preliminary Bracket race to match ==========
  console.log('=== STEP 2: Link Preliminary Bracket race ===\n');
  
  const prelimRace = await Race.findById(PRELIMINARY_RACE_ID).lean();
  if (!prelimRace) {
    console.log('Preliminary race not found:', PRELIMINARY_RACE_ID);
  } else {
    console.log('Race:', prelimRace.url);
    const entrantNames = prelimRace.entrants?.map(e => e.userName || e.user?.name || e.name).filter(Boolean) || [];
    console.log('Entrants:', entrantNames.join(' vs '));
    
    // Find matching match in tournament
    let matchingMatch = null;
    if (tournament.matches && tournament.matches.length > 0) {
      for (const match of tournament.matches) {
        const p1 = (match.player1?.name || '').toLowerCase();
        const p2 = (match.player2?.name || '').toLowerCase();
        
        // Check if both entrants match
        const entrantNamesLower = entrantNames.map(n => n.toLowerCase());
        const matchesP1 = entrantNamesLower.some(e => 
          e.includes(p1) || p1.includes(e) || 
          e.replace(/[^a-z0-9]/g, '') === p1.replace(/[^a-z0-9]/g, '')
        );
        const matchesP2 = entrantNamesLower.some(e => 
          e.includes(p2) || p2.includes(e) ||
          e.replace(/[^a-z0-9]/g, '') === p2.replace(/[^a-z0-9]/g, '')
        );
        
        if (matchesP1 && matchesP2 && p1 !== 'tbd' && p2 !== 'tbd') {
          matchingMatch = match;
          break;
        }
      }
    }
    
    if (matchingMatch) {
      console.log('Found matching match:');
      console.log(`  ${matchingMatch.player1?.name} vs ${matchingMatch.player2?.name}`);
      console.log(`  Round: ${matchingMatch.round}, Pool: ${matchingMatch.phaseGroup}, Phase: ${matchingMatch.phase}`);
      
      if (!dryRun) {
        // Update race with tournamentId and match info
        await Race.updateOne(
          { _id: prelimRace._id },
          { 
            $set: { 
              tournamentId: new mongoose.Types.ObjectId(TOURNAMENT_ID),
              tournamentPhase: matchingMatch.phase,
              tournamentPool: matchingMatch.phaseGroup,
              tournamentRound: matchingMatch.round,
              matchPlayers: `${matchingMatch.player1?.name} vs ${matchingMatch.player2?.name}`
            },
            $currentDate: { updatedAt: true }
          }
        );
        
        // Update match with race URL
        await Tournament.updateOne(
          { _id: TOURNAMENT_ID, 'matches.startggSetId': matchingMatch.startggSetId },
          {
            $set: {
              'matches.$.raceUrl': prelimRace.url,
              'matches.$.raceId': prelimRace._id.toString()
            }
          }
        );
        
        console.log('✅ Linked race to match\n');
      } else {
        console.log('🔍 Would link race to match\n');
      }
    } else {
      console.log('⚠️ No matching match found in tournament\n');
    }
  }
  
  // ========== STEP 3: Link qualification races to tournament ==========
  console.log('=== STEP 3: Link qualification races ===\n');
  
  // Get remaining original races (excluding preliminary and duplicates)
  const qualificationRaces = originals.filter(r => r._id.toString() !== PRELIMINARY_RACE_ID);
  
  console.log(`Found ${qualificationRaces.length} qualification races to link\n`);
  
  let linkedCount = 0;
  for (const race of qualificationRaces) {
    const entrantCount = race.entrants?.length || 0;
    console.log(`  📝 ${race.url} (${entrantCount} entrants, ${race.startedAt?.toISOString().slice(0,10)})`);
    
    if (!dryRun) {
      await Race.updateOne(
        { _id: race._id },
        { 
          $set: { 
            tournamentId: new mongoose.Types.ObjectId(TOURNAMENT_ID),
            tournamentPhase: 'Qualifications'
          },
          $currentDate: { updatedAt: true }
        }
      );
      linkedCount++;
    }
  }
  
  if (!dryRun) {
    console.log(`\n✅ Linked ${linkedCount} qualification races to tournament\n`);
  } else {
    console.log(`\n🔍 Would link ${qualificationRaces.length} qualification races\n`);
  }
  
  // ========== Summary ==========
  console.log('=== SUMMARY ===');
  console.log(`Duplicates deleted: ${dryRun ? '(dry run) ' : ''}${duplicates.length}`);
  console.log(`Preliminary race linked: ${dryRun ? '(dry run) ' : ''}${prelimRace ? 'Yes' : 'No'}`);
  console.log(`Qualification races linked: ${dryRun ? '(dry run) ' : ''}${qualificationRaces.length}`);
  
  await mongoose.disconnect();
  console.log('\nDone!');
}

main().catch(err => { 
  console.error(err); 
  process.exit(1); 
});
