# Automatisation du site Randomizer

Ce document décrit l'architecture d'automatisation complète du site Randomizer, incluant les GitHub Actions, scripts de synchronisation, et la gestion des données.

## 📋 Vue d'ensemble

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          ARCHITECTURE D'AUTOMATISATION                          │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  ┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐        │
│  │  rando-list      │     │  racetime.gg     │     │  challonge.com   │        │
│  │  (GitHub)        │     │  (API)           │     │  (API v1)        │        │
│  └────────┬─────────┘     └────────┬─────────┘     └────────┬─────────┘        │
│           │                        │                        │                   │
│           ▼                        ▼                        ▼                   │
│  ┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐        │
│  │ Workflow         │     │ Workflow         │     │ sync-tournaments │        │
│  │ sync-rando-list  │     │ sync-racetime    │     │ discover-tourn.  │        │
│  │ (1x/jour)        │     │ (5 min)          │     │ (1x/jour)        │        │
│  └────────┬─────────┘     └────────┬─────────┘     └────────┬─────────┘        │
│           │                        │                        │                   │
│           │                        │              ┌─────────┴─────────┐        │
│           │                        │              │  start.gg         │        │
│           │                        │              │  (GraphQL API)    │        │
│           │                        │              └─────────┬─────────┘        │
│           │                        │                        │                   │
│           └────────────────┬───────┴────────────────────────┘                   │
│                            ▼                                                    │
│                   ┌──────────────────┐                                          │
│                   │    MongoDB       │                                          │
│                   │  - Games         │                                          │
│                   │  - Races         │                                          │
│                   │  - Tournaments   │                                          │
│                   │  - Players       │                                          │
│                   └────────┬─────────┘                                          │
│                            │                                                    │
│                            ▼                                                    │
│                   ┌──────────────────┐                                          │
│                   │   API Express    │                                          │
│                   │   (server.js)    │                                          │
│                   └────────┬─────────┘                                          │
│                            │                                                    │
│                            ▼                                                    │
│                   ┌──────────────────┐                                          │
│                   │   Frontend       │                                          │
│                   │   (public/)      │                                          │
│                   └──────────────────┘                                          │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## 🔄 Workflows GitHub Actions

### 1. sync-rando-list.yml (Quotidien - 6h00 UTC)

**Objectif**: Synchroniser la liste des jeux randomizer depuis le repo officiel.

**Déclencheurs**:
- ⏰ Cron: `0 6 * * *` (tous les jours à 6h00 UTC)
- 🔘 Manuel: workflow_dispatch
- 🔔 Webhook: repository_dispatch (optionnel)

**Étapes**:
1. Vérifier si des changements existent depuis le dernier sync
2. Cloner/pull le repo rando-list
3. Parser les fichiers YAML des séries
4. Mettre à jour le cache MongoDB (`rando_list_cache`)
5. Mettre à jour les ressources des jeux (sites, URLs)
6. Détecter les nouveaux randomizers
7. (Optionnel) Synchroniser les races pour les nouveaux jeux

### 2. sync-racetime.yml (Toutes les 5 minutes)

**Objectif**: Récupérer les nouvelles courses depuis racetime.gg.

**Déclencheurs**:
- ⏰ Cron: `*/5 * * * *` (toutes les 5 minutes)
- 🔘 Manuel: workflow_dispatch

**Étapes**:
1. Récupérer la liste des jeux actifs avec intégration racetime
2. Pour chaque jeu, récupérer les nouvelles courses
3. Insérer/mettre à jour les courses en BDD
4. Respecter les rate limits (1.5s entre requêtes)

### 3. sync-tournaments (Quotidien ou manuel)

**Objectif**: Découvrir et importer automatiquement les tournois "Randomizer" et "Multiworld" depuis start.gg et challonge.com.

**Déclencheurs**:
- ⏰ Cron: `0 4 * * *` (tous les jours à 4h00 UTC) – recommandé
- 🔘 Manuel: `npm run sync:tournaments` ou `npm run discover:tournaments`

**Architecture**:

```
discover-tournaments.js          sync-tournaments.js
    │                                │
    ├── Cherche sur start.gg         ├── Met à jour les tournois actifs
    │   (GraphQL search API)         │   (re-fetch participants/matches)
    │                                │
    ├── Cherche sur Challonge        ├── Découvre les nouveaux tournois
    │   (REST API v1)                │   (délègue à discover-tournaments.js)
    │                                │
    ├── Filtre par mots-clés         └── Conçu pour exécution cron
    │   "randomizer", "multiworld"
    │   + noms de jeux de la BDD
    │
    └── Importe & upsert en BDD
```

**Scripts**:

| Commande | Description |
|----------|-------------|
| `npm run discover:tournaments` | Découverte complète (toutes sources) |
| `npm run discover:tournaments:dry` | Mode aperçu sans import |
| `npm run discover:tournaments:startgg` | Start.gg uniquement |
| `npm run discover:tournaments:challonge` | Challonge uniquement |
| `npm run sync:tournaments` | Sync automatique (mise à jour + découverte) |
| `npm run sync:tournaments:dry` | Sync en mode aperçu |
| `npm run import:startgg <url>` | Import d'un tournoi start.gg spécifique |
| `npm run import:challonge <id>` | Import d'un tournoi Challonge spécifique |

**Options CLI**:
```bash
node scripts/discover-tournaments.js --source startgg     # Source unique
node scripts/discover-tournaments.js --since 2024-01-01   # Depuis une date
node scripts/discover-tournaments.js --game ootr           # Un seul jeu
node scripts/discover-tournaments.js --max-pages 5         # Limiter la pagination
node scripts/discover-tournaments.js --keywords "keyword"  # Mots-clés supplémentaires
node scripts/sync-tournaments.js --days 7                  # Derniers N jours
node scripts/sync-tournaments.js --update-only             # Mise à jour uniquement
```

**Détection des tournois randomizer**:
Le script identifie les tournois via :
1. Mots-clés de base : `randomizer`, `randomiser`, `rando`, `multiworld`, `archipelago`…
2. Noms des jeux présents en BDD (nom court, tinyName, etc.)
3. Noms de jeu start.gg / gameName Challonge
4. Helper `findGameForTournament()` pour le mapping vers les jeux internes

**Variables d'environnement requises**:
```bash
STARTGG_API_TOKEN=xxx     # Token API start.gg (GraphQL)
CHALLONGE_API_KEY=xxx     # Clé API Challonge v1
CHALLONGE_USERNAME=xxx    # Username Challonge (pour listing)
```

## 📁 Structure des scripts

```
scripts/
├── sync-rando-list-v3.js        # Sync principal avec rando-list
├── check-rando-list-changes.js  # Détection des changements
├── sync-racetime-global.js      # Sync races (toutes les 5 min)
├── sync-racetime-game.js        # Sync complet des races d'un jeu
├── sync-speedrunslive.js        # Historique des races randomizer SpeedRunsLive
├── discover-tournaments.js      # Découverte de tournois (start.gg + challonge)
├── sync-tournaments.js          # Mise à jour des tournois actifs (cron)
├── auto-link-tournaments.js     # Liaison automatique races ↔ matchs
├── import-startgg.js            # Import d'un tournoi start.gg spécifique
└── import-challonge.js          # Import d'un tournoi Challonge spécifique
```

## 🗃️ Structure des données

### Collection `games` - Nouveau schéma

```javascript
{
  // CORE IDENTITY (contrôlé manuellement)
  id: String,           // ex: "alttp"
  name: String,         // Nom complet
  shortName: String,    // Nom court (ex: "ALTTPR")
  tinyName: String,     // Très court (ex: "ALBWR") - NOUVEAU

  // OFFICIAL GAME INFO
  official: {
    name: String,
    releaseDate: Date,
    releaseYear: Number,  // NOUVEAU
    website: String
  },

  // RANDOMIZER INFO
  randomizer: {
    displayName: String,
    name: String,
    website: String,
    opensource: Boolean,
    addedDate: Date,      // NOUVEAU - depuis rando-list
    updatedDate: Date     // NOUVEAU - depuis rando-list
  },

  // RESOURCES (NOUVEAU - Section complète)
  resources: {
    officialSite: {
      url: String,
      name: String,
      isArchipelago: Boolean
    },
    sites: [{
      url: String,
      name: String,
      source: 'rando-list' | 'manual',
      isArchipelago: Boolean,
      isObsolete: Boolean
    }],
    trackers: [{
      url: String,
      name: String,
      description: String,
      source: 'manual'
    }],
    guides: [{
      url: String,
      name: String,
      description: String,
      type: 'guide' | 'tutorial' | 'wiki' | 'video',
      source: 'manual'
    }],
    other: [{
      url: String,
      name: String,
      description: String,
      type: String,
      source: 'manual'
    }]
  },

  // INTEGRATIONS
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
  }
}
```

## 🎯 Logique d'affichage des boutons

### Sur la page `games.html` et `game-detail.html`:

```
SI resources.officialSite.url EXISTE:
    SI resources.officialSite.isArchipelago:
        → Afficher bouton "🏝️ Archipelago"
    SINON:
        → Afficher bouton "🌐 Site officiel"
        
SINON SI resources.sites.length === 1:
    SI resources.sites[0].isArchipelago:
        → Afficher bouton "🏝️ Archipelago"
    SINON:
        → Afficher bouton "🌐 Site officiel"
        
SINON SI resources.sites.length > 1:
    → Afficher section "Sites" avec tous les liens
    → Le site officiel doit être défini manuellement
    
SINON SI randomizer.website EXISTE (legacy):
    → Afficher bouton "🌐 Site officiel"
```

## ⚙️ Configuration requise

### Secrets GitHub (Settings → Secrets → Actions)

| Nom | Description |
|-----|-------------|
| `MONGODB_URI` | URI de connexion MongoDB Atlas |
| `DISCORD_WEBHOOK_URL` | (Optionnel) Notifications d'erreurs |

### Variables GitHub (Settings → Variables → Actions)

| Nom | Valeur par défaut | Description |
|-----|-------------------|-------------|
| `RACETIME_RATE_LIMIT_MS` | `1500` | Délai entre requêtes racetime (ms) |

## 🚀 Mise en place initiale

### 1. Pousser le code sur GitHub

```bash
git add .github/workflows/*.yml scripts/*.js
git commit -m "feat: add automation workflows"
git push origin main
```

### 2. Configurer les secrets

1. Aller dans **Settings** → **Secrets and variables** → **Actions**
2. Ajouter `MONGODB_URI` avec l'URI MongoDB Atlas

### 3. Activer les workflows

Les workflows se déclenchent automatiquement selon le cron, ou manuellement:

1. Aller dans **Actions**
2. Sélectionner le workflow
3. Cliquer **Run workflow**

### 4. Première synchronisation

```bash
# Exécuter manuellement la sync initiale
npm run sync-rando-list

# Ou la version V3 avec ressources
node scripts/sync-rando-list-v3.js --link-games
```

## 📊 Monitoring

### Vérifier les exécutions

1. GitHub → Actions → Voir l'historique des workflows
2. Chaque run affiche un résumé avec:
   - Nombre de nouvelles races
   - Nouveaux jeux détectés
   - Erreurs éventuelles

### Logs en BDD

La collection `rando_list_cache` contient les métadonnées:

```javascript
db.rando_list_cache.findOne({ _id: '_metadata' })
// {
//   lastSync: ISODate("2026-01-26T..."),
//   commitHash: "abc123...",
//   seriesCount: 45,
//   totalGames: 180,
//   totalRandomizers: 520
// }
```

## 🔧 Maintenance

### Forcer une resynchronisation complète

```bash
# Via GitHub Actions : workflow "Sync Racetime Game (Full Recovery)"

# Ou en local, jeu par jeu
node scripts/sync-racetime-game.js --game ootr --max-pages 100
```

### Ajouter un nouveau tracker manuellement

```bash
# Via l'API (nécessite authentification admin - à implémenter)
curl -X PATCH /api/games/alttp/resources \
  -H "Content-Type: application/json" \
  -d '{"trackers": [{"url": "https://...", "name": "EmoTracker"}]}'
```

### Corriger une association jeu-randomizer

```javascript
// En MongoDB
db.games.updateOne(
  { id: "alttp" },
  { 
    $set: { 
      "integrations.randoList.randomizerIdentifier": "alttpr",
      "integrations.randoList.confidence": "manual"
    }
  }
)
```

## ❓ FAQ

### Q: Pourquoi toutes les 5 minutes pour les races ?

Racetime.gg a des courses en temps réel. 5 minutes est un bon compromis entre:
- Avoir des données fraîches
- Ne pas surcharger leur API
- Rester dans les limites gratuites de GitHub Actions (~2000 min/mois)

### Q: Comment ajouter un jeu manuellement ?

Pour l'instant, créer le document directement en BDD. Une interface admin est prévue pour le futur.

### Q: L'association races-tournois automatique est-elle possible ?

C'est complexe car:
- Les noms de courses ne suivent pas de convention stricte
- Les tournois Challonge n'ont pas d'identifiant racetime
- Il faudrait du machine learning ou des règles très sophistiquées

Recommandation: Garder un workflow semi-manuel avec scripts d'aide (`auto-link-races.js`).

## 📈 Évolutions futures

1. **Interface admin** pour gérer manuellement les ressources
2. **Notifications Discord** pour les nouveaux jeux/races
3. **API Speedrun.com** pour enrichir les données (année de sortie, plateformes)
4. **Cache Redis** pour améliorer les performances
5. **Association ML** races↔tournois avec scoring de confiance
