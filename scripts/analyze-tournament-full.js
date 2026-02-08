const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const connectDB = require('../config/database');
const { Tournament } = require('../models');

(async () => {
  try {
    await connectDB();
    const t = await Tournament.findById('69811a47855ce1115e6633cd');
    
    console.log('\n📊 FULL Tournament Matches Analysis');
    console.log(`Tournament: ${t.name}`);
    console.log(`Type: ${t.tournamentType}`);
    console.log(`Total matches: ${t.matches.length}`);
    console.log(`Phases: ${JSON.stringify(t.phases?.map(p => ({ name: p.name, bracketType: p.bracketType, id: p.startggPhaseId })))}`);
    
    // Group by phase then by round
    const byPhase = {};
    t.matches.forEach(m => {
      const phase = m.phase || 'Unknown';
      if (!byPhase[phase]) byPhase[phase] = {};
      const r = m.round || 0;
      if (!byPhase[phase][r]) byPhase[phase][r] = [];
      byPhase[phase][r].push(m);
    });
    
    Object.keys(byPhase).forEach(phase => {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`PHASE: ${phase}`);
      console.log(`${'='.repeat(60)}`);
      
      const rounds = Object.keys(byPhase[phase]).map(r => parseInt(r)).sort((a, b) => a - b);
      console.log(`Rounds: ${rounds.join(', ')}`);
      
      rounds.forEach(round => {
        const matches = byPhase[phase][round];
        console.log(`\n  Round ${round} (${matches.length} matches):`);
        matches.forEach((m, idx) => {
          const p1 = m.player1?.name || 'TBD';
          const p2 = m.player2?.name || 'TBD';
          const score = m.displayScore || '';
          const state = m.state;
          const winner = m.winnerId;
          console.log(`    [${idx}] ${p1} vs ${p2} | Score: ${score} | State: ${state} | WinnerId: ${winner}`);
        });
      });
    });
    
    process.exit(0);
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
})();
