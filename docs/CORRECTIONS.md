# Corrections apportées

## Problèmes résolus

### 1. Duplication de "Randomizer" dans les noms ✅
**Problème:** Les noms de randomizer apparaissaient comme "ALttP Randomizer Randomizer"

**Cause:** Le CSV avait déjà "Randomizer" dans `official rando name` et le script ajoutait aussi le champ `randomizerName`

**Solution:** Ajout d'un nettoyage dans `buildFullUpdateData` et `buildNewGameData` qui détecte et supprime les doublons :
```javascript
const cleaned = randoName.replace(/\s+Randomizer\s+Randomizer$/i, ' Randomizer');
```

### 2. Images non affichées ✅
**Problème:** Les images n'apparaissaient pas alors qu'elles sont dans `public/assets/`

**Cause:** Le script CSV ne définissait pas les chemins d'images et le code frontend cherchait avec des slugs

**Solution:**
- Script CSV : Ajout automatique de `logo: 'assets/${gameId}.png'` et `image: 'assets/${gameId}.png'`
- Frontend : Utilisation directe de `game.image` ou `game.logo` avec fallback sur l'ID

### 3. Affichage page game-detail ✅
**Problème:** Le nom du randomizer s'affichait mais pas le nom du jeu en dessous

**Cause:** Le code utilisait l'ancien schéma avec `officialName` au lieu du nouveau `official.name` et `randomizer.name`

**Solution:** Adaptation du code pour utiliser :
- `game.randomizer?.name` → Titre principal (h1, jaune)
- `game.official?.name` → Nom du jeu (h2, gris en dessous)

## Fichiers modifiés

### Scripts
- ✅ [scripts/import-games-csv.js](scripts/import-games-csv.js)
  - Nettoyage de la duplication "Randomizer"
  - Ajout automatique des chemins d'images avec préfixe `assets/`

### Frontend
- ✅ [public/js/game-detail.js](public/js/game-detail.js)
  - Utilisation de `game.randomizer.name` et `game.official.name`
  - Chargement d'images simplifié depuis `game.image/logo`

- ✅ [public/js/games.js](public/js/games.js)
  - Affichage adapté au nouveau schéma
  - Fonction `getGameImage()` simplifiée

### Nouveau script de seed
- ✅ [scripts/seed-games-v2.js](scripts/seed-games-v2.js)
  - Seed avec le nouveau schéma complet
  - Tous les jeux avec `official`, `randomizer`, `integrations`

## Comment réimporter correctement

```bash
# 1. Si tu veux repartir de zéro avec le nouveau schéma
node scripts/seed-games-v2.js

# 2. Ou migrer les jeux existants puis réimporter ton CSV
node scripts/migrations/migrate-game-schema.js --apply
node scripts/import-games-csv.js data/games.csv --full

# 3. Vérifier le résultat
# Ouvre http://localhost:3000/games.html
# Les images doivent s'afficher depuis assets/
# Les noms ne doivent plus avoir de doublon "Randomizer"
```

## Structure finale d'un jeu

```json
{
  "id": "alttp",
  "name": "A Link to the Past",
  "shortName": "ALttP",
  "series": "Zelda Series",
  "logo": "assets/alttp.png",
  "image": "assets/alttp.png",
  "platforms": ["SNES", "Switch"],
  
  "official": {
    "name": "The Legend of Zelda: A Link to the Past",
    "releaseDate": "1991-11-21",
    "website": null
  },
  
  "randomizer": {
    "name": "A Link to the Past Randomizer",
    "website": "https://alttpr.com",
    "opensource": true
  },
  
  "integrations": {
    "randoList": { "enabled": false },
    "racetime": { "enabled": true, "gameSlug": "alttpr" },
    "speedrun": { "enabled": true, "gameId": "alttp" }
  }
}
```

## Prochaine étape

Tu peux maintenant lancer le sync rando-list :

```bash
node scripts/sync-rando-list-v2.js --link-games --dry-run
```
