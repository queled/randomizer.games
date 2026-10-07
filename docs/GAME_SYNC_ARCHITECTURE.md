# Architecture de synchronisation des jeux

## Vue d'ensemble

```
┌─────────────────────────────────────────────────────────────────┐
│                     SOURCES DE DONNÉES                          │
├─────────────────┬─────────────────┬─────────────────────────────┤
│   rando-list    │  speedrun.com   │      racetime.gg            │
│   (GitHub)      │     (API)       │         (API)               │
│                 │                 │                             │
│ • Liste jeux    │ • Plateformes   │ • Disponibilité races       │
│ • Randomizers   │ • Date sortie   │ • Slug catégorie            │
│ • URLs          │ • Images        │ • Nom affiché               │
└────────┬────────┴────────┬────────┴──────────────┬──────────────┘
         │                 │                       │
         │     ┌───────────┴───────────┐           │
         │     │                       │           │
         ▼     ▼                       ▼           ▼
┌─────────────────────────────────────────────────────────────────┐
│                         SCRIPTS                                 │
├─────────────────┬─────────────────┬─────────────────────────────┤
│ sync-rando-list │  enrich-games   │     import-games-csv        │
│    -v3.js       │      .js        │           .js               │
│                 │                 │                             │
│ • Clone/pull    │ • Enrichit      │ • Import manuel             │
│ • Parse YAML    │   depuis APIs   │ • Mapping IDs               │
│ • Cache MongoDB │ • Safe (no      │ • Mode link-only            │
│ • Link auto     │   overwrite     │                             │
│                 │   manual)       │                             │
└────────┬────────┴────────┬────────┴──────────────┬──────────────┘
         │                 │                       │
         └─────────────────┼───────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                    MONGODB - Collection "games"                 │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ id: "alttp" (TON id unique, immutable)                    │  │
│  │                                                           │  │
│  │ name, shortName, platforms, series, logo, image           │  │
│  │                                                           │  │
│  │ official: { name, releaseDate, website }                  │  │
│  │ randomizer: { name, website, opensource }                 │  │
│  │                                                           │  │
│  │ integrations: {                                           │  │
│  │   randoList: { enabled, seriesFile, gameName, ... }       │  │
│  │   racetime:  { enabled, gameSlug, gameName, ... }         │  │
│  │   speedrun:  { enabled, gameId, weblink, ... }            │  │
│  │ }                                                         │  │
│  │                                                           │  │
│  │ source: { origin: 'manual'|'csv-import'|'seed', ... }     │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Principe de fonctionnement

### 1. TON ID = Source de vérité

Tu contrôles les IDs de tes jeux. Les IDs externes (speedrun.com, racetime, rando-list) sont stockés dans `integrations.*` mais n'écrasent jamais ton ID.

### 2. Confidence = Protection

Chaque intégration a un champ `confidence`:
- `manual` : Données définies par toi, JAMAIS écrasées par l'auto-sync
- `auto` : Données trouvées automatiquement, peuvent être mises à jour

### 3. Safe par défaut

Tous les scripts ont un mode `--dry-run` par défaut. Aucune modification sans action explicite.

## Workflow recommandé

### Étape 1: Importer ton CSV de mapping

Ton CSV doit avoir les colonnes:
- `my id` : Ton ID unique
- `id game speedrun.com` : ID speedrun.com
- `id rando racetime.gg` : Slug racetime.gg
- etc.

```bash
# Voir ce qui serait fait
node scripts/import-games-csv.js data/games.csv --dry-run

# Ajouter uniquement les liens (safe)
node scripts/import-games-csv.js data/games.csv --link-only

# Import complet (écrase)
node scripts/import-games-csv.js data/games.csv --full
```

### Étape 2: Sync rando-list

```bash
# Sync le cache uniquement
node scripts/sync-rando-list-v3.js

# Sync + liaison automatique aux jeux (dry-run)
node scripts/sync-rando-list-v3.js --link-games --dry-run

# Sync + liaison (apply)
node scripts/sync-rando-list-v3.js --link-games
```

### Étape 3: Enrichir depuis les APIs

```bash
# Voir ce qui serait enrichi
node scripts/enrich-games.js --dry-run

# Enrichir depuis speedrun.com
node scripts/enrich-games.js --speedrun

# Enrichir depuis racetime.gg
node scripts/enrich-games.js --racetime

# Tout enrichir
node scripts/enrich-games.js --all

# Enrichir un seul jeu
node scripts/enrich-games.js --speedrun --game=alttp
```

## Format du CSV

```csv
my id,id game speedrun.com,id rando racetime.gg,very shortname rando racetime.gg,shortname rando,official rando name,game name,full game name,full rando name,année de sortie du jeu,série,plateforme
alttp,alttp,alttpr,ALTTPR,ALttP Randomizer,A Link to the Past Randomizer,A Link to the Past,The Legend of Zelda: A Link to the Past,A Link to the Past Randomizer,1991,Zelda Series,"SNES, Switch"
oot,oot,ootr,OOTR,OOT Randomizer,Ocarina of Time Randomizer,Ocarina of Time,The Legend of Zelda: Ocarina of Time,Ocarina of Time Randomizer,1998,Zelda Series,"N64, GCN, 3DS, Switch"
```

## Automatisation

Le sync rando-list tourne chaque jour via le workflow GitHub Actions `sync-rando-list.yml`.
Il peut aussi être lancé à la main depuis le panneau admin (onglet Sync).
L'ancien webhook `/api/sync-rando-list/webhook` a été supprimé : il lançait un script obsolète.

### Cron recommandé

```bash
# Sync quotidien
0 3 * * * cd /path/to/project && node scripts/sync-rando-list-v3.js --link-games >> logs/sync.log 2>&1

# Enrichissement hebdomadaire
0 4 * * 0 cd /path/to/project && node scripts/enrich-games.js --all >> logs/enrich.log 2>&1
```

## Schéma MongoDB complet

```javascript
{
  // === IDENTITÉ (TU contrôles) ===
  id: String,           // UNIQUE, IMMUTABLE (ex: "alttp", "albw")
  name: String,         // Nom court du jeu (ex: "A Link to the Past")
  shortName: String,    // Acronyme du randomizer (ex: "ALttP Randomizer")
  
  // === INFOS OFFICIELLES DU JEU ===
  official: {
    name: String,       // Nom complet officiel du jeu (ex: "The Legend of Zelda: A Link to the Past")
    releaseDate: Date,
    website: String
  },
  
  // === INFOS DU RANDOMIZER ===
  randomizer: {
    displayName: String, // ⭐ NOM AFFICHÉ EN UI (ex: "A Link to the Past Randomizer")
    name: String,        // Nom complet du randomizer (ex: "The Legend of Zelda: A Link to the Past Randomizer")
    website: String,     // Site du randomizer (ex: "https://alttpr.com")
    opensource: Boolean
  },
  
  // === MÉDIAS ===
  platforms: [String],
  logo: String,         // Chemin relatif: "assets/alttp.png"
  image: String,        // Chemin relatif: "assets/alttp.png"
  series: String,       // Ex: "Zelda Series"
  
  // === CATÉGORIES ===
  categories: [{
    id: String,
    name: String,
    description: String
  }],
  
  // === INTÉGRATIONS EXTERNES ===
  integrations: {
    randoList: {
      enabled: Boolean,
      seriesFile: String,
      gameName: String,
      randomizerIdentifier: String,
      confidence: 'manual' | 'auto',
      lastSync: Date
    },
    racetime: {
      enabled: Boolean,
      gameSlug: String,
      gameName: String,
      confidence: 'manual' | 'auto',
      lastSync: Date
    },
    speedrun: {
      enabled: Boolean,
      gameId: String,
      weblink: String,
      confidence: 'manual' | 'auto',
      lastSync: Date
    }
  },
  
  // === MÉTADONNÉES ===
  source: {
    origin: 'seed' | 'csv-import' | 'rando-list' | 'manual',
    importedAt: Date
  },
  enabled: Boolean,
  
  // Mongoose timestamps
  createdAt: Date,
  updatedAt: Date
}
```

## Mapping CSV → MongoDB

| Colonne CSV | Champ MongoDB | Exemple | Usage |
|-------------|---------------|---------|-------|
| `my id` | `id` | `alttp` | Identifiant unique |
| `game name` | `name` | `A Link to the Past` | Nom court du jeu |
| `shortname rando` | `shortName` | `ALttP Randomizer` | Acronyme |
| `official rando name` | `randomizer.displayName` | `A Link to the Past Randomizer` | ⭐ **TITRE AFFICHÉ** |
| `full game name` | `official.name` | `The Legend of Zelda: A Link to the Past` | Sous-titre affiché |
| `full rando name` | `randomizer.name` | `The Legend of Zelda: A Link to the Past Randomizer` | Nom complet officiel |
| `id game speedrun.com` | `integrations.speedrun.gameId` | `alttp` | Lien speedrun.com |
| `id rando racetime.gg` | `integrations.racetime.gameSlug` | `alttpr` | Lien racetime.gg |
| `very shortname rando racetime.gg` | `integrations.racetime.shortName` | `ALTTPR` | Acronyme racetime |
| `année de sortie du jeu` | `official.releaseDate` | `1991-11-21` | Date de sortie |
| `série` | `series` | `Zelda Series` | Franchise |
| `plateforme` | `platforms[]` | `["SNES", "Switch"]` | Plateformes |

### Affichage Frontend

- **Titre principal (h1)** : `randomizer.displayName` → "A Link to the Past Randomizer"
- **Sous-titre (h2)** : `official.name` → "The Legend of Zelda: A Link to the Past"
- **Liste des jeux** : `randomizer.displayName` ou `shortName` en fallback
