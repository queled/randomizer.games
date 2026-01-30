const fs = require('fs');
const path = require('path');

// Fonction pour créer un ID suggéré à partir d'un nom
function createSuggestedId(originalName) {
  // Enlever les parenthèses et leur contenu
  let name = originalName.replace(/\s*\([^)]*\)/g, '');
  
  // Remplacer les caractères spéciaux par des espaces
  name = name.replace(/[&:'']/g, ' ');
  
  // Convertir en kebab-case
  name = name.toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w-]/g, '')
    .replace(/--+/g, '-')
    .replace(/^-+|-+$/g, '');
  
  return name;
}

// Fonction pour créer le randomizerShortName
function createShortName(originalName) {
  // Enlever les parenthèses et leur contenu
  let name = originalName.replace(/\s*\([^)]*\)/g, '');
  
  // Enlever les caractères spéciaux sauf espaces
  name = name.replace(/[&:'']/g, ' ');
  
  // Créer un acronyme ou garder le nom court
  const words = name.trim().split(/\s+/);
  
  // Si c'est un nom long, faire un acronyme
  if (words.length > 3 || name.length > 25) {
    const acronym = words
      .map(w => w[0])
      .join('')
      .toUpperCase();
    return `${acronym} Rando`;
  }
  
  // Sinon, garder le nom en majuscules
  return `${name.toUpperCase()} Rando`;
}

// Fonction pour créer le randomizerTinyName
function createTinyName(originalName) {
  // Enlever les parenthèses et leur contenu
  let name = originalName.replace(/\s*\([^)]*\)/g, '');
  
  // Enlever les caractères spéciaux sauf espaces
  name = name.replace(/[&:'']/g, ' ');
  
  // Créer un acronyme
  const words = name.trim().split(/\s+/);
  
  // Si plusieurs mots, faire un acronyme
  if (words.length > 1) {
    return words
      .map(w => w[0])
      .join('')
      .toUpperCase();
  }
  
  // Sinon, garder le nom court en majuscules
  return name.toUpperCase();
}

// Lire le fichier
const filePath = path.join(__dirname, 'tmp', 'new-games-report.json');
const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

// Tracker les IDs pour détecter les doublons
const idMap = new Map();
const duplicates = [];

// Traiter chaque jeu
data.games.forEach((game, index) => {
  const suggestedId = createSuggestedId(game.originalName);
  
  // Vérifier si l'ID n'est pas déjà défini ou est vide
  if (!game.id || game.id === game.originalName.toLowerCase()) {
    game.id = suggestedId;
  }
  
  // Vérifier si le suggestedId n'est pas déjà défini
  if (!game.suggestedId || game.suggestedId === game.originalName.toLowerCase()) {
    game.suggestedId = suggestedId;
  }
  
  // Créer randomizerShortName si nécessaire
  if (!game.randomizerShortName || game.randomizerShortName.includes('Randomizer')) {
    game.randomizerShortName = createShortName(game.originalName);
  }
  
  // Créer randomizerTinyName si nécessaire
  if (!game.randomizerTinyName) {
    game.randomizerTinyName = createTinyName(game.originalName);
  }
  
  // Vérifier les doublons d'ID
  if (idMap.has(game.id)) {
    duplicates.push({
      id: game.id,
      games: [
        { index: idMap.get(game.id), name: data.games[idMap.get(game.id)].originalName },
        { index: index, name: game.originalName }
      ]
    });
  } else {
    idMap.set(game.id, index);
  }
});

// Sauvegarder le fichier modifié
fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');

console.log('✅ Fichier traité avec succès!');
console.log(`📊 Total de jeux: ${data.games.length}`);

// Afficher les doublons
if (duplicates.length > 0) {
  console.log('\n⚠️  ATTENTION - IDs en doublon détectés:');
  duplicates.forEach(dup => {
    console.log(`\n  ID: "${dup.id}"`);
    dup.games.forEach(g => {
      console.log(`    - [${g.index}] ${g.name}`);
    });
  });
} else {
  console.log('\n✅ Aucun ID en doublon détecté');
}
