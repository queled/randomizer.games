/**
 * Analyze race entrants to identify real Racetime names
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { Race, Tournament } = require('../models');

const aliases = {
  'Aranaut': 'TheAranaut',
  'Challensois': 'Challensois_',
  'Cola': 'cola_osu',
  'Flouche': 'Flouflouche',
  'Jaybone25 (invitation pending)': 'Jaybone25',
  'Meanmido (invitation pending)': 'meanmido',
  'Pyra': 'Pyra2366',
  'r0bd0g (invitation pending)': 'r0bd0g',
  'Riley': 'Riley2w69t',
  'TrenteR': 'TrenteR_TR',
  'Volc': 'Volc-41'
};

async function main() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/randomizer');
    
    console.log('🔍 Analyse des noms dans les races...\n');
    
    // Get all races with their entrants
    const races = await Race.find({}, { entrants: 1, name: 1, url: 1 });
    
    // Build set of exact names as they appear in Racetime races
    const racetimeNames = new Set();
    const nameExamples = new Map(); // Store example races where name appears
    
    races.forEach(r => {
      if (r.entrants) {
        r.entrants.forEach(e => {
          if (e.userName) {
            racetimeNames.add(e.userName);
            if (!nameExamples.has(e.userName)) {
              nameExamples.set(e.userName, []);
            }
            nameExamples.get(e.userName).push(r.url || r.name);
          }
        });
      }
    });
    
    console.log(`Total de noms uniques dans les races Racetime: ${racetimeNames.size}\n`);
    
    // Check each alias pair
    const results = [];
    
    for (const [challongeName, racetimeName] of Object.entries(aliases)) {
      const cleanChallonge = challongeName.replace(' (invitation pending)', '').trim();
      
      // Check exact matches in race entrants (these are real Racetime names)
      const racetimeInRaces = racetimeNames.has(racetimeName);
      const challongeInRaces = racetimeNames.has(cleanChallonge);
      
      // Check case-insensitive variations
      const racetimeVariations = Array.from(racetimeNames).filter(n => 
        n.toLowerCase() === racetimeName.toLowerCase()
      );
      const challongeVariations = Array.from(racetimeNames).filter(n => 
        n.toLowerCase() === cleanChallonge.toLowerCase()
      );
      
      results.push({
        challongeName: cleanChallonge,
        racetimeName,
        racetimeInRaces,
        challongeInRaces,
        racetimeVariations,
        challongeVariations,
        racetimeExamples: racetimeInRaces ? nameExamples.get(racetimeName).slice(0, 2) : [],
        challongeExamples: challongeInRaces ? nameExamples.get(cleanChallonge).slice(0, 2) : []
      });
    }
    
    console.log('═══════════════════════════════════════════════════════');
    console.log('📊 ANALYSE DES ALIASES');
    console.log('═══════════════════════════════════════════════════════\n');
    
    const correct = [];
    const inverted = [];
    const uncertain = [];
    
    results.forEach(r => {
      if (r.racetimeInRaces && !r.challongeInRaces) {
        correct.push(r);
      } else if (!r.racetimeInRaces && r.challongeInRaces) {
        inverted.push(r);
      } else {
        uncertain.push(r);
      }
    });
    
    if (correct.length > 0) {
      console.log('✅ ALIASES CORRECTS (nom de droite existe dans les races):');
      correct.forEach(r => {
        console.log(`\n   '${r.challongeName}': '${r.racetimeName}'`);
        console.log(`   → ${r.racetimeName} apparaît dans: ${r.racetimeExamples.join(', ')}`);
      });
      console.log('\n');
    }
    
    if (inverted.length > 0) {
      console.log('⚠️  ALIASES INVERSÉS (nom de gauche existe dans les races, pas celui de droite):');
      inverted.forEach(r => {
        console.log(`\n   '${r.challongeName}': '${r.racetimeName}' ← INVERSER`);
        console.log(`   → ${r.challongeName} apparaît dans: ${r.challongeExamples.join(', ')}`);
        console.log(`   → ${r.racetimeName} n'apparaît pas dans les races`);
        console.log(`   CORRECTION: '${r.racetimeName}': '${r.challongeName}'`);
      });
      console.log('\n');
    }
    
    if (uncertain.length > 0) {
      console.log('❓ INCERTAINS (les deux ou aucun n\'apparaissent):');
      uncertain.forEach(r => {
        console.log(`\n   '${r.challongeName}': '${r.racetimeName}'`);
        if (r.racetimeInRaces && r.challongeInRaces) {
          console.log(`   → Les DEUX noms existent dans les races!`);
          console.log(`      ${r.challongeName}: ${r.challongeExamples.join(', ')}`);
          console.log(`      ${r.racetimeName}: ${r.racetimeExamples.join(', ')}`);
        } else if (r.racetimeVariations.length > 0) {
          console.log(`   → Variations trouvées pour ${r.racetimeName}: ${r.racetimeVariations.join(', ')}`);
        } else if (r.challongeVariations.length > 0) {
          console.log(`   → Variations trouvées pour ${r.challongeName}: ${r.challongeVariations.join(', ')}`);
        } else {
          console.log(`   → Aucun des deux noms n'apparaît dans les races Racetime`);
          console.log(`   → Vérifier manuellement sur racetime.gg/user/<nom>`);
        }
      });
    }
    
  } catch (error) {
    console.error('Erreur:', error);
  } finally {
    await mongoose.disconnect();
  }
}

main();
