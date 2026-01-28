/**
 * Analyze races linked to tournament matches to find player name mappings
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { Race, Match, Tournament } = require('../models');

async function main() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/randomizer');
    
    console.log('🔍 Analyse des correspondances Challonge → Racetime...\n');
    
    // Get races that are linked to matches (have matchId)
    const linkedRaces = await Race.find({ matchId: { $exists: true, $ne: null } });
    
    console.log(`Races liées à des matchs: ${linkedRaces.length}\n`);
    
    // For each linked race, get the match and compare player names
    const mappings = new Map(); // challongeName -> Set of racetimeNames
    
    for (const race of linkedRaces) {
      if (!race.matchId) continue;
      
      const match = await Match.findById(race.matchId);
      if (!match) continue;
      
      const challongeNames = [match.player1Name, match.player2Name].filter(Boolean);
      const racetimeEntrants = (race.entrants || []).map(e => ({
        userName: e.userName,
        userId: e.userId || e.user?.id,
        userUrl: e.userUrl || e.user?.url
      })).filter(e => e.userName);
      
      // If we have 2 challonge players and 2 racetime entrants, they should match
      if (challongeNames.length === 2 && racetimeEntrants.length >= 2) {
        // Try to match by name similarity
        for (const challongeName of challongeNames) {
          const normalized = challongeName.toLowerCase().replace(/[^a-z0-9]/g, '');
          
          for (const entrant of racetimeEntrants) {
            const entrantNorm = entrant.userName.toLowerCase().replace(/[^a-z0-9]/g, '');
            
            // Check if names are similar
            if (normalized === entrantNorm || 
                normalized.includes(entrantNorm) || 
                entrantNorm.includes(normalized)) {
              
              if (!mappings.has(challongeName)) {
                mappings.set(challongeName, new Set());
              }
              mappings.get(challongeName).add(JSON.stringify({
                racetimeName: entrant.userName,
                userId: entrant.userId,
                raceUrl: race.url
              }));
            }
          }
        }
      }
    }
    
    console.log('═══════════════════════════════════════════════════════');
    console.log('📊 CORRESPONDANCES TROUVÉES (Challonge → Racetime)');
    console.log('═══════════════════════════════════════════════════════\n');
    
    const sortedMappings = Array.from(mappings.entries()).sort((a, b) => 
      a[0].localeCompare(b[0])
    );
    
    for (const [challongeName, racetimeSet] of sortedMappings) {
      const racetimeData = Array.from(racetimeSet).map(s => JSON.parse(s));
      
      // Group by userName
      const byName = new Map();
      racetimeData.forEach(d => {
        if (!byName.has(d.racetimeName)) {
          byName.set(d.racetimeName, []);
        }
        byName.get(d.racetimeName).push(d);
      });
      
      console.log(`"${challongeName}"`);
      for (const [rtName, occurrences] of byName.entries()) {
        console.log(`  → "${rtName}" (${occurrences.length} race(s))`);
        if (occurrences[0].userId) {
          console.log(`     userId: ${occurrences[0].userId}`);
        }
        console.log(`     ex: ${occurrences[0].raceUrl}`);
      }
      console.log('');
    }
    
    // Now check for specific players mentioned by user
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('🎯 VÉRIFICATION DES JOUEURS SPÉCIFIQUES');
    console.log('═══════════════════════════════════════════════════════\n');
    
    const checkPlayers = [
      { challonge: 'Challensois', racetime: 'Challensois_' },
      { challonge: 'Jaybone25', racetime: 'Jaybone25' },
      { challonge: 'Meanmido', racetime: 'meanmido' },
      { challonge: 'r0bd0g', racetime: 'r0bd0g' },
      { challonge: 'Riley', racetime: 'Riley' },
      { challonge: 'TrenteR', racetime: 'TrenteR' }
    ];
    
    for (const check of checkPlayers) {
      const challongeData = mappings.get(check.challonge);
      const challongeDataPending = mappings.get(check.challonge + ' (invitation pending)');
      
      console.log(`Challonge: "${check.challonge}" / Racetime supposé: "${check.racetime}"`);
      
      if (challongeData || challongeDataPending) {
        const data = challongeData || challongeDataPending;
        const racetimeData = Array.from(data).map(s => JSON.parse(s));
        const names = [...new Set(racetimeData.map(d => d.racetimeName))];
        
        if (names.includes(check.racetime)) {
          console.log(`  ✅ CONFIRMÉ: "${check.challonge}" correspond à "${check.racetime}"`);
        } else {
          console.log(`  ⚠️  ATTENTION: "${check.challonge}" correspond à: ${names.join(', ')}`);
          console.log(`     (et non "${check.racetime}")`);
        }
      } else {
        console.log(`  ❌ Aucune correspondance trouvée dans les races liées`);
      }
      console.log('');
    }
    
  } catch (error) {
    console.error('Erreur:', error);
  } finally {
    await mongoose.disconnect();
  }
}

main();
