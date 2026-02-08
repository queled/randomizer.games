const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const connectDB = require('../config/database');
const { Tournament } = require('../models');

(async () => {
  try {
    await connectDB();
    const t = await Tournament.findById('69811a47855ce1115e6633cd');
    
    console.log('\n📊 Tournament Matches Analysis:');
    console.log(`Total matches: ${t.matches.length}\n`);
    console.log('Tournament type:', t.tournamentType);
    console.log('Phases:', JSON.stringify(t.phases, null, 2));
    
    // Group by round
    const byRound = {};
    t.matches.forEach(m => {
      const r = m.round || 0;
      if (!byRound[r]) byRound[r] = [];
      byRound[r].push(m);
    });
    
    const sortedRounds = Object.keys(byRound).map(r => parseInt(r)).sort((a, b) => a - b);
    
    console.log('\nRounds found:', sortedRounds.join(', '));
    
    sortedRounds.forEach(round => {
      const matches = byRound[round];
      console.log(`\n=== Round ${round} (${matches.length} matches) ===`);
      matches.forEach((m, idx) => {
        console.log(`  [${idx}] ${m.player1?.name || 'TBD'} vs ${m.player2?.name || 'TBD'} | Phase: ${m.phase} | PhaseGroup: ${m.phaseGroup} | State: ${m.state} | Winner: ${m.winnerId} | SetId: ${m.startggSetId} | DisplayScore: ${m.displayScore}`);
      });
    });
    
    process.exit(0);
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
})();
