/**
 * Check Racetime profiles via server API
 */
require('dotenv').config();

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

async function checkName(name) {
  try {
    const url = `https://racetime.gg/user/${encodeURIComponent(name)}`;
    const response = await fetch(url, { 
      method: 'HEAD',
      redirect: 'manual'
    });
    return response.status === 200 || response.status === 304;
  } catch (e) {
    return false;
  }
}

async function main() {
  console.log('🔍 Vérification des profils Racetime...\n');
  
  const results = [];
  
  for (const [challongeName, racetimeName] of Object.entries(aliases)) {
    console.log(`Vérification: "${challongeName}" → "${racetimeName}"`);
    
    const racetimeExists = await checkName(racetimeName);
    const challongeExists = await checkName(challongeName.replace(' (invitation pending)', ''));
    
    results.push({
      challongeName,
      racetimeName,
      racetimeExists,
      challongeExists
    });
    
    await new Promise(resolve => setTimeout(resolve, 200)); // Rate limit
  }
  
  console.log('\n📊 Résultats:\n');
  
  const correct = [];
  const inverted = [];
  const uncertain = [];
  
  results.forEach(r => {
    if (r.racetimeExists && !r.challongeExists) {
      correct.push(r);
    } else if (!r.racetimeExists && r.challongeExists) {
      inverted.push(r);
    } else if (r.racetimeExists && r.challongeExists) {
      uncertain.push(r);
    } else {
      uncertain.push(r);
    }
  });
  
  if (correct.length > 0) {
    console.log('✅ CORRECT (profil Racetime existe):');
    correct.forEach(r => {
      console.log(`   "${r.challongeName}" → "${r.racetimeName}"`);
    });
    console.log('');
  }
  
  if (inverted.length > 0) {
    console.log('⚠️  INVERSÉ (le nom Challonge a un profil Racetime):');
    inverted.forEach(r => {
      console.log(`   "${r.challongeName}" → "${r.racetimeName}" (devrait être inversé)`);
    });
    console.log('');
  }
  
  if (uncertain.length > 0) {
    console.log('❓ INCERTAIN (les deux existent ou aucun):');
    uncertain.forEach(r => {
      console.log(`   "${r.challongeName}" (${r.challongeExists ? 'existe' : 'n\'existe pas'}) → "${r.racetimeName}" (${r.racetimeExists ? 'existe' : 'n\'existe pas'})`);
    });
  }
}

main().catch(console.error);
