#!/usr/bin/env node
/**
 * Script to update Start.gg matches with winnerId parsed from displayScore
 * Usage: node scripts/fix-startgg-winner.js
 */

const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/randomizer';
const TOURNAMENT_ID = '69811a47855ce1115e6633cd';

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to DB\n');
  
  const { Race, Tournament } = require('../models');
  
  // Load tournament
  const tournament = await Tournament.findById(TOURNAMENT_ID);
  if (!tournament) {
    console.error('Tournament not found');
    process.exit(1);
  }
  
  console.log('Tournament:', tournament.name);
  console.log('Matches:', tournament.matches?.length || 0);
  console.log('');
  
  let updated = 0;
  let skipped = 0;
  
  for (const match of tournament.matches || []) {
    // Skip if already has winnerId
    if (match.winnerId) {
      skipped++;
      continue;
    }
    
    // Parse displayScore: "PlayerA W - PlayerB L" or "PlayerA L - PlayerB W"
    if (match.displayScore && typeof match.displayScore === 'string') {
      const parts = match.displayScore.split(' - ');
      if (parts.length === 2) {
        const p1Part = parts[0].trim(); // "PlayerA W"
        const p2Part = parts[1].trim(); // "PlayerB L"
        
        let winner = null;
        
        // Check if player1 won
        if (p1Part.endsWith(' W')) {
          winner = match.player1?.startggEntrantId;
        }
        // Check if player2 won
        else if (p2Part.endsWith(' W')) {
          winner = match.player2?.startggEntrantId;
        }
        
        if (winner) {
          match.winnerId = winner;
          updated++;
          console.log(`✅ ${match.player1?.name} vs ${match.player2?.name} → Winner: ${winner}`);
        } else {
          console.log(`⚠️  Could not parse winner from: "${match.displayScore}"`);
        }
      }
    }
  }
  
  if (updated > 0) {
    await tournament.save();
    console.log(`\n✅ Updated ${updated} matches with winnerId`);
  }
  
  console.log(`⏭️  Skipped ${skipped} matches (already have winnerId)`);
  
  // Now update the race
  console.log('\n=== Updating race ===');
  const prelimRace = await Race.findById('6982857e782e88c02d3cdd06');
  if (prelimRace) {
    const match = tournament.matches.find(m => 
      m.player1?.name === 'MrMario7788' && m.player2?.name === 'Oakishi'
    );
    
    if (match) {
      prelimRace.tournamentId = new mongoose.Types.ObjectId(TOURNAMENT_ID);
      prelimRace.tournamentPhase = match.phase;
      prelimRace.tournamentPool = match.phaseGroup;
      prelimRace.tournamentRound = match.round;
      prelimRace.matchPlayers = `${match.player1?.name} vs ${match.player2?.name}`;
      
      await prelimRace.save();
      console.log('✅ Updated race /ootr/snug-malon-1313');
    }
  }
  
  await mongoose.disconnect();
  console.log('\nDone!');
}

main().catch(err => { 
  console.error(err); 
  process.exit(1); 
});
