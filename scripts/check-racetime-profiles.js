const names = [
  'TheAranaut',
  'Challensois_',
  'cola_osu',
  'Flouflouche',
  'Jaybone25',
  'meanmido',
  'Pyra2366',
  'r0bd0g',
  'Riley2w69t',
  'TrenteR_TR',
  'Volc-41',
  // Also check the aliases
  'Aranaut',
  'Challensois',
  'Cola',
  'Flouche',
  'Pyra',
  'Riley',
  'TrenteR',
  'Volc'
];

async function checkRacetime(name) {
  try {
    const response = await fetch(`https://racetime.gg/user/${encodeURIComponent(name)}`);
    return { name, exists: response.ok, status: response.status };
  } catch (e) {
    return { name, exists: false, error: e.message };
  }
}

async function checkAll() {
  console.log('Checking Racetime profiles...\n');
  const results = await Promise.all(names.map(checkRacetime));
  
  console.log('=== CANONICAL NAMES (should exist on Racetime) ===');
  results.slice(0, 11).forEach(r => {
    const status = r.exists ? '✅' : '❌';
    console.log(`${status} ${r.name}`);
  });
  
  console.log('\n=== ALIAS NAMES (checking if inverted) ===');
  results.slice(11).forEach(r => {
    const status = r.exists ? '✅' : '❌';
    console.log(`${status} ${r.name}`);
  });
}

checkAll().catch(console.error);
