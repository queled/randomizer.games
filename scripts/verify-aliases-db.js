/**
 * Check player names in local database to verify aliases
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { Player, Race } = require('../models');

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
    
    console.log('🔍 Vérification des aliases dans la base de données...\n');
    
    // Get all Player documents
    const players = await Player.find({});
    const playersByName = new Map();
    players.forEach(p => {
      playersByName.set(p.name.toLowerCase().trim(), p);
    });
    
    // Get all race entrants
    const races = await Race.find({}, { entrants: 1 });
    const entrantNames = new Set();
    races.forEach(r => {
      if (r.entrants) {
        r.entrants.forEach(e => {
          if (e.userName) entrantNames.add(e.userName);
        });
      }
    });
    
    console.log(`Joueurs avec profil Racetime: ${players.length}`);
    console.log(`Noms d'entrants uniques: ${entrantNames.size}\n`);
    
    const results = [];
    
    for (const [challongeName, racetimeName] of Object.entries(aliases)) {
      const cleanChallonge = challongeName.replace(' (invitation pending)', '');
      
      const racetimeInDB = playersByName.has(racetimeName.toLowerCase().trim());
      const challongeInDB = playersByName.has(cleanChallonge.toLowerCase().trim());
      
      const racetimeInRaces = entrantNames.has(racetimeName);
      const challongeInRaces = entrantNames.has(cleanChallonge);
      
      let racetimeProfile = null;
      let challongeProfile = null;
      
      if (racetimeInDB) {
        racetimeProfile = playersByName.get(racetimeName.toLowerCase().trim());
      }
      if (challongeInDB) {
        challongeProfile = playersByName.get(cleanChallonge.toLowerCase().trim());
      }
      
      results.push({
        challongeName: cleanChallonge,
        racetimeName,
        racetimeInDB,
        challongeInDB,
        racetimeInRaces,
        challongeInRaces,
        racetimeHasUrl: racetimeProfile?.racetimeUrl ? true : false,
        challongeHasUrl: challongeProfile?.racetimeUrl ? true : false,
        racetimeUrl: racetimeProfile?.racetimeUrl || null,
        challongeUrl: challongeProfile?.racetimeUrl || null
      });
    }
    
    console.log('📊 Résultats:\n');
    
    results.forEach(r => {
      console.log(`"${r.challongeName}" → "${r.racetimeName}"`);
      
      if (r.racetimeInDB && r.racetimeHasUrl) {
        console.log(`  ✅ ${r.racetimeName}: profil Racetime (${r.racetimeUrl})`);
      } else if (r.racetimeInRaces) {
        console.log(`  ⚪ ${r.racetimeName}: dans les races mais pas de profil complet`);
      } else {
        console.log(`  ❌ ${r.racetimeName}: pas dans la DB`);
      }
      
      if (r.challongeInDB && r.challongeHasUrl) {
        console.log(`  ⚠️  ${r.challongeName}: a AUSSI un profil Racetime (${r.challongeUrl}) - POSSIBLEMENT INVERSÉ`);
      } else if (r.challongeInRaces) {
        console.log(`  ⚪ ${r.challongeName}: dans les races`);
      } else {
        console.log(`  ⚪ ${r.challongeName}: seulement dans Challonge`);
      }
      
      console.log('');
    });
    
    console.log('\n💡 Recommandations:');
    const inverted = results.filter(r => r.challongeHasUrl && !r.racetimeHasUrl);
    if (inverted.length > 0) {
      console.log('\n⚠️  Ces aliases semblent INVERSÉS:');
      inverted.forEach(r => {
        console.log(`   Changer: '${r.challongeName}': '${r.racetimeName}'`);
        console.log(`   En:      '${r.racetimeName}': '${r.challongeName}'`);
      });
    }
    
    const ok = results.filter(r => r.racetimeHasUrl && !r.challongeHasUrl);
    if (ok.length > 0) {
      console.log('\n✅ Ces aliases semblent CORRECTS:');
      ok.forEach(r => {
        console.log(`   '${r.challongeName}': '${r.racetimeName}'`);
      });
    }
    
  } catch (error) {
    console.error('Erreur:', error);
  } finally {
    await mongoose.disconnect();
  }
}

main();
