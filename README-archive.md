# Randomizer

🎮 **Plateforme centralisée pour les tournois de randomizer**

Randomizer est une plateforme web complète dédiée aux tournois de jeux randomizers. Elle centralise les données de tournois, races et statistiques depuis Challonge et Racetime.gg, offrant une expérience unifiée pour suivre les compétitions, analyser les performances et consulter l'historique des joueurs.

## 📑 Table des matières

- [✨ Fonctionnalités](#-fonctionnalités)
- [🏗️ Architecture](#️-architecture)
- [🚀 Installation](#-installation)
- [📡 API Endpoints](#-api-endpoints)
- [🔄 Synchronisation et scripts](#-synchronisation-et-scripts)
- [📚 Utilisation](#-utilisation)
- [🧠 Algorithmes clés](#-algorithmes-clés)
- [🎯 Différences avec Speedrun.com](#-différences-avec-speedruncom)
- [🛠️ Technologies](#️-technologies)
- [📦 Structure du projet](#-structure-du-projet)
- [🔐 Sécurité](#-sécurité)
- [🚧 Roadmap](#-roadmap)
- [📝 Licence](#-licence)
- [👨‍💻 Auteur](#-auteur)
- [📞 Support & Contribution](#-support--contribution)

## ✨ Fonctionnalités

### 🏆 Gestion des tournois
- Import automatique depuis Challonge (brackets, phases de poule, matchs)
- Détection intelligente du jeu associé (via nom/description du tournoi)
- Support des formats : Simple/Double élimination, Round Robin, Swiss, Groupes + Simple élimination
- Visualisation complète : bracket interactif, classement participants, matchs détaillés
- Liaison automatique des matchs aux races Racetime.gg

### 🎯 Races et résultats
- Importation depuis Racetime.gg (statuts, temps, entrants)
- Parsing intelligent des temps (ISO 8601, HH:MM:SS, millisecondes)
- Tracking des statuts : done, dnf, dq, in_progress
- Liaison race ↔ match avec scoring heuristique (Levenshtein, noms normalisés)
- Affichage avec rangs (médailles 🥇🥈🥉), temps de finish, liens vers profils

### 👤 Profils joueurs
- Agrégation automatique depuis Racetime.gg et Challonge
- Statistiques : total races, victoires, meilleur temps, temps moyen
- Historique complet des participations aux tournois
- Intégration avatars Racetime.gg et streams Twitch
- Pages dédiées avec races, tournois, graphiques de performance

### 🔍 Recherche globale
- Recherche multi-critères : jeux, tournois, races, joueurs
- Normalisation intelligente (accents, casse, variantes de noms)
- Suggestions automatiques de catégories (ex: "Ocarina" → oot/ootr)
- Tri par pertinence et filtrage avancé

### 🙈 Mode anti-spoiler
- **Toggle global** : bouton présent sur toutes les pages, persistance sessionStorage
- **Re-rendu dynamique** : événement `spoilerModeChanged` pour mise à jour instantanée sans rechargement
- **Pages tournois** : participants triés alphabétiquement, bracket masqué, phases de groupes sans V/D
- **Pages races** : liste alphabétique sans rangs ni temps, titre adaptatif ("🏅 Classement" / "👥 Participants")
- **Listes** : masquage vainqueurs/résultats via classes CSS `.spoiler-block` / `.spoiler-winner`

### 📊 Intégrations externes
- **Streams Twitch** : détection automatique des streams en direct par jeu
- **Avatars Racetime.gg** : proxy d'avatars avec fallback intelligent
- **Enrichissement automatique** : mise à jour périodique des données

## 🏗️ Architecture

### Backend
- **Node.js v16+ + Express 4.18** : API RESTful avec middleware compression, helmet, CORS
- **MongoDB 4.4+ (Mongoose 8.0)** : Base de données NoSQL avec schémas typés et indexes optimisés
- **Axios 1.6** : Client HTTP pour APIs externes (Challonge, Racetime.gg, Twitch)
- **Node-cache** : Cache en mémoire (TTL 5min) pour streams et avatars
- **Sanitize-html** : Nettoyage des descriptions HTML importées de Challonge

### Frontend
- **HTML5 + CSS3** : Pages statiques avec design responsive
- **Vanilla JavaScript** : Modules découplés (api.js, spoiler-mode.js, page-specific)
- **Architecture orientée événements** : `spoilerModeChanged` pour synchronisation inter-composants
- **Fetch API** : Communication asynchrone avec le backend
- **sessionStorage** : Persistance préférences utilisateur (mode anti-spoiler)

### Base de données (MongoDB)
**Collections principales** :
- `games` : Jeux supportés (id, name, shortName, categories, logo)
- `tournaments` : Tournois (challongeId, game ref, participants, type, dates)
- `matches` : Matchs (tournamentId, players, scores, winnerId, raceUrl, groupId)
- `races` : Courses (url unique, category, entrants[], status, tournamentId, matchId)
- `players` : Joueurs (userId, name, stats, tournaments[])

**Indexes optimisés** :
- `tournaments` : `{ game: 1, startDate: -1 }`, `{ gameId: 1, startDate: -1 }`
- `races` : `{ category: 1, startedAt: -1 }`, `{ status: 1, startedAt: -1 }`, `{ tournamentId: 1 }`
- `matches` : `{ tournamentId: 1 }`
- `players` : `{ name: 1 }`

### Services externes
- **Challonge API v1** : Import tournois (authentification API key + username)
- **Racetime.gg API** : Fetch races, avatars, profils utilisateurs (public, sans auth)
- **Twitch API (Helix)** : Détection streams en direct (OAuth client credentials)

## 🚀 Installation

### Prérequis
- Node.js v16+ ([télécharger](https://nodejs.org/))
- MongoDB v4.4+ ([télécharger](https://www.mongodb.com/try/download/community))
- npm ou yarn (inclus avec Node.js)
- Compte Challonge avec API key
- (Optionnel) Compte Twitch Developer pour streams API

### Configuration

**1. Cloner et installer les dépendances**
```bash
cd V2
npm install
```

**2. Configurer les variables d'environnement**
```bash
cp .env.example .env
```

Éditer `.env` avec vos valeurs :
```env
# Database
MONGODB_URI=mongodb://localhost:27017/randomizer

# Challonge API (obligatoire pour sync tournois)
CHALLONGE_API_KEY=your_api_key_here
CHALLONGE_USERNAME=your_username

# Twitch API (optionnel, pour streams en direct)
TWITCH_CLIENT_ID=your_client_id
TWITCH_CLIENT_SECRET=your_client_secret

# Server
PORT=3000
NODE_ENV=development
```

**3. Obtenir les clés API**

**Challonge** :
1. Se connecter sur https://challonge.com
2. Aller dans Settings → Developer API
3. Générer une clé API
4. Copier la clé dans `.env`

**Twitch** (optionnel) :
1. Se connecter sur https://dev.twitch.tv
2. Console → Applications → Register Your Application
3. Créer une application (OAuth Redirect URLs: http://localhost)
4. Copier Client ID et Secret dans `.env`

**4. Démarrer MongoDB**
```bash
# macOS (Homebrew)
brew services start mongodb-community

# Linux (systemd)
sudo systemctl start mongod

# Windows
# Démarrer MongoDB via Services ou :
"C:\Program Files\MongoDB\Server\4.4\bin\mongod.exe" --dbpath="C:\data\db"
```

**5. Initialiser les données**
```bash
# Seeder les jeux de base (OOT, ALTTP, MM, etc.)
node scripts/seed-games.js
```

### Démarrage

**Mode développement** (hot-reload avec Nodemon) :
```bash
npm run dev
```

**Mode production** :
```bash
npm start
```

Le serveur démarre sur **http://localhost:3000**

### Vérification
- **Frontend** : http://localhost:3000
- **API Health** : http://localhost:3000/api/health
- **Liste jeux** : http://localhost:3000/api/games

### Premier import de données
```bash
# Importer un tournoi Challonge (remplacer <challonge-id> par l'ID du tournoi)
curl -X POST http://localhost:3000/api/sync/tournament/<challonge-id> \
  -H "Content-Type: application/json" \
  -d '{"gameSlug": "oot"}'

# Exemple avec Season 8 OOT Randomizer
curl -X POST http://localhost:3000/api/sync/tournament/zsrootrs8 \
  -H "Content-Type: application/json" \
  -d '{"gameSlug": "oot"}'
```

## 📡 API Endpoints

### Jeux (`/api/games`)
- `GET /api/games` - Liste tous les jeux (avec count tournois/races)
- `GET /api/games/:id` - Détails d'un jeu spécifique
- `GET /api/games/:id/tournaments` - Tournois d'un jeu (filtres: year, state, limit)
- `GET /api/games/:id/stats` - Statistiques agrégées (tournois, races, joueurs actifs)

### Tournois (`/api/tournaments`)
- `GET /api/tournaments` - Liste paginée avec filtres (game, state, year, limit)
- `GET /api/tournaments/:id` - Détails complets (participants, stats)
- `GET /api/tournaments/:id/matches` - Tous les matchs du tournoi (avec raceUrl)
- `GET /api/tournaments/:id/races` - Toutes les races associées au tournoi

### Races (`/api/runs`)
- `GET /api/runs` - Liste avec filtres (category, status, tournament, player, limit)
- `GET /api/runs/:id` - Détails d'une race (entrants, temps, tournoi associé)
- Support filtres avancés : `startDate`, `endDate`, `recordable`

### Joueurs (`/api/players`)
- `GET /api/players` - Liste paginée avec stats (limit, offset, sort)
- `GET /api/players/by-name/:name` - Profil par nom d'utilisateur
- `GET /api/players/by-name/:name/races` - Historique des races d'un joueur
- `GET /api/players/:id/races` - Races par ID MongoDB (legacy)

### Synchronisation (`/api/sync`)
- `POST /api/sync/tournament/:challongeId` - Import/update tournoi depuis Challonge
  - Body: `{ gameId, gameSlug }` (optionnel, détection auto sinon)
- `POST /api/sync/races/:tournamentId` - Link races Racetime.gg à un tournoi
  - Body: `{ category, tournamentName, startDate?, endDate? }`
- Détection automatique des correspondances race ↔ match via scoring heuristique

### Racetime.gg (`/api/racetime`)
- `GET /api/racetime/avatar?id=<userId>` - Proxy avatar utilisateur
- `GET /api/racetime/has-avatar?name=<userName>` - Check existence avatar
- `GET /api/racetime/find?category=<cat>&startDate=<date>` - Recherche races par critères
- `GET /api/racetime/twitch?id=<userId>` - Username Twitch depuis profil Racetime.gg

### Streams (`/api/streams`)
- `GET /api/streams/:gameId` - Streams Twitch en direct pour un jeu
  - Retourne : `{ live: true/false, streams: [...] }`
  - Cache 5min, fallback si API Twitch indisponible
- `GET /api/streams` - Tous les streams actifs (agrégé tous jeux)

### Recherche (`/api/search`)
- `GET /api/search?q=<query>&limit=<n>` - Recherche globale multi-types
  - Retourne : `{ results: { games, tournaments, races, players }, counts }`
  - Normalisation texte (accents, casse), regex flexible, catégories dérivées

### Santé
- `GET /api/health` - Healthcheck (status, timestamp, version)

## 🔄 Synchronisation et scripts

### Import manuel d'un tournoi
```bash
curl -X POST http://localhost:3000/api/sync/tournament/zsrootrs8 \
  -H "Content-Type: application/json" \
  -d '{"gameSlug": "oot"}'
```

### Liaison races Racetime.gg à un tournoi
```bash
curl -X POST http://localhost:3000/api/sync/races/695a95d95922ec8980b493b8 \
  -H "Content-Type: application/json" \
  -d '{"category": "ootr", "tournamentName": "Season 8"}'
```

### Scripts disponibles

#### Gestion des données
- **`seed-games.js`** : Initialise la collection Games avec 10+ jeux (OOT, ALTTP, MM, KH2, etc.)
  ```bash
  node scripts/seed-games.js
  ```

#### Liaison races ↔ matchs
- **`auto-link-races.js <raceUrl1> [raceUrl2...]`** : Lie races spécifiques aux matchs
- **`auto-link-races-global.js <raceUrl>`** : Recherche match dans TOUS les tournois (scoring global)
- **`link-race-to-match.js <raceUrl> <matchId>`** : Liaison manuelle forcée
- **`unlink-race.js <raceUrl>`** : Supprime la liaison race → match

#### Import et enrichissement
- **`import-and-link-racetime.js <racePath> [tournamentId]`** : Import race Racetime.gg + auto-link
  ```bash
  node scripts/import-and-link-racetime.js /ootr/proud-kakariko-8125 693e97490f2f2b79e46b3c09
  ```
- **`enrich-races.js`** : Met à jour les races existantes (statuts, temps, entrants)
- **`import-player-marco.js`** : Import spécifique pour joueurs (exemple)

#### Migrations
- **`backfill-populate-source.js [--apply]`** : Ajoute métadonnées `source` aux documents (dry-run par défaut)
- **`migrate-add-game-ref.js`** : Migration game ObjectId refs
- **`migrate-convert-times.js`** : Conversion temps vers format milliseconds
- **`bulk-convert-finishTimes.js`** : Normalisation batch des finishTime

### Auto-sync (optionnel)
Configuration avec node-cron dans `server.js` :
```javascript
const cron = require('node-cron');

// Tous les jours à 3h du matin
cron.schedule('0 3 * * *', async () => {
  console.log('🔄 Sync automatique...');
  // Appeler API /sync/races pour tournois actifs
  // Enrichir races récentes via Racetime.gg
});
```

## 📚 Utilisation

### 1. Seeder les jeux initiaux
```bash
node scripts/seed-games.js
```
Crée les documents Game pour : OOT, ALTTP, MM, SM, SM64, TWW, TP, KH2, SotN, SMZ3, OOT+MM.

### 2. Importer un tournoi Challonge
```bash
# Via API
curl -X POST http://localhost:3000/api/sync/tournament/zsrootrs8 \
  -H "Content-Type: application/json" \
  -d '{"gameSlug": "oot"}'

# Ou directement via script si besoin
# Le helper findGameForTournament détecte automatiquement le jeu
```

### 3. Lier les races Racetime.gg
```bash
# Liaison automatique par tournoi
curl -X POST http://localhost:3000/api/sync/races/695a95d95922ec8980b493b8 \
  -H "Content-Type: application/json" \
  -d '{
    "category": "ootr",
    "tournamentName": "Season 8",
    "startDate": "2024-01-01",
    "endDate": "2024-12-31"
  }'

# Ou lien manuel pour une race spécifique
node scripts/link-race-to-match.js /ootr/proud-kakariko-8125 693e974b0f2f2b79e46b3c48
```

### 4. Consulter les données
- **Frontend** : http://localhost:3000
  - `/index.html` : Accueil avec derniers tournois/races
  - `/tournaments.html` : Liste tous les tournois
  - `/tournament-detail.html?id=<id>` : Détail tournoi avec bracket
  - `/races.html` : Liste toutes les races
  - `/race-detail.html?id=<id>` : Détail race avec classement
  - `/players.html` : Liste joueurs
  - `/player-detail.html?name=<name>` : Profil joueur
  - `/games.html` : Liste jeux
  - `/game-detail.html?id=<slug>` : Détail jeu avec stats
  - `/search.html?q=<query>` : Recherche globale

- **API** : http://localhost:3000/api
  - Endpoints documentés dans section "📡 API Endpoints"

### 5. Mode anti-spoiler
- Cliquer sur le toggle en haut à droite sur n'importe quelle page
- État persisté dans `sessionStorage` (disparaît à la fermeture du navigateur)
- Re-rendu instantané : participants, brackets, phases de groupes, classements

## 🧠 Algorithmes clés

### Liaison races ↔ matchs (scoring heuristique)
Le système utilise un algorithme de scoring sophistiqué pour associer automatiquement les races Racetime.gg aux matchs Challonge :

**Critères de matching** :
1. **Noms de joueurs** : Normalisation (accents, casse, espaces) + Levenshtein distance
   - Match exact : 300 points
   - Tokens communs : 180-220 points
   - Similarité Levenshtein : 0-160 points
2. **Temps de course** : Cohérence avec winner déclaré dans Challonge
   - Vainqueur match = vainqueur race : bonus 100 points
3. **Fenêtre temporelle** : Distance match.completedAt ↔ race.endedAt
   - < 1h : bonus 50 points
   - 1-6h : bonus 30 points
   - > 24h : pénalité -100 points
4. **Déjà lié** : Pénalité -1000 si race déjà assignée

**Seuil d'acceptation** : Score > 300 pour auto-link

**Scripts disponibles** :
- `auto-link-races.js` : Link par tournamentId (recherche locale)
- `auto-link-races-global.js` : Recherche dans TOUS les matchs (utile pour races orphelines)

### Parsing intelligent des temps
Support multi-formats pour `finishTime` :
- **ISO 8601 duration** : `PT1H23M45S` → 4825000ms
- **HH:MM:SS** : `1:23:45` → 4825000ms
- **MM:SS** : `23:45` → 1425000ms
- **Millisecondes** : `4825000` → 4825000ms
- **Secondes** : `4825` → 4825000ms (si < 10000)

Conversion automatique via `pre-save` hooks Mongoose (races, players).

### Détection automatique du jeu (helper)
`findGameForTournament.js` utilise une cascade de stratégies :
1. Slug explicite fourni (`gameSlug` param)
2. ObjectId MongoDB fourni (`gameId` param)
3. **Heuristique nom/description** : recherche mots-clés dans nom/description tournoi
   - Exemple : "Season 8 OOT Randomizer" → détecte `oot`
   - Fallback sur noms officiels jeux

## 🎯 Différences avec Speedrun.com

| Speedrun.com | Randomizer |
|--------------|----------------|
| Classement global de temps | ❌ Pas pertinent (seeds différentes) |
| Catégories fixes | ✅ Catégories + règles combinées |
| Runs individuelles | ✅ Confrontations en tournoi |
| Leaderboards | ✅ Brackets et phases de poule |
| Meilleur temps global | ✅ Meilleur temps par tournoi/seed |

## 🛠️ Technologies

### Backend
- **Node.js 16+** : Runtime JavaScript côté serveur
- **Express 4.18** : Framework web minimaliste et flexible
- **Mongoose 8.0** : ODM MongoDB avec schémas typés et validation
- **Axios 1.6** : Client HTTP promesses pour APIs externes
- **Helmet 7.1** : Sécurité headers HTTP
- **CORS 2.8** : Gestion Cross-Origin Resource Sharing
- **Compression 1.7** : Compression gzip des réponses
- **Node-cache 5.1** : Cache en mémoire (streams, avatars)
- **Sanitize-html 2.17** : Nettoyage HTML (descriptions tournois)
- **dotenv 16.3** : Gestion variables d'environnement

### Frontend
- **HTML5** : Structure sémantique moderne
- **CSS3** : Design responsive avec variables CSS, grids, flexbox
- **Vanilla JavaScript ES6+** : Modules découplés sans framework
  - `api.js` : Client API centralisé
  - `spoiler-mode.js` : Gestion toggle anti-spoiler global
  - `global-search.js` : Recherche temps réel avec debounce
  - Modules par page : `tournament-detail.js`, `race-detail.js`, `player-detail.js`, etc.

### Database
- **MongoDB 4.4+** : Base NoSQL orientée documents
- **Indexes** : Optimisations query performance (compound indexes sur game+date, category+date, etc.)
- **Schemas Mongoose** : Validation typage fort (Games, Tournaments, Matches, Races, Players)
- **Pre-save hooks** : Parsing automatique temps (ISO 8601 → ms)

### Dev Tools
- **Nodemon 3.0** : Hot-reload serveur en développement
- **dotenv** : Configuration environnement (.env)

### APIs Externes
- **Challonge API v1** : Import tournois (REST, authentification API key)
- **Racetime.gg API** : Fetch races, avatars, profils (public REST)
- **Twitch API Helix** : Streams en direct (OAuth2 client credentials)

## 📦 Structure du projet

```
V2/
├── config/
│   └── database.js              # Connexion MongoDB (mongoose.connect)
├── models/
│   └── index.js                 # Schémas Mongoose (Game, Tournament, Match, Race, Player)
├── routes/
│   ├── games.js                 # Routes jeux (GET /, /:id, /:id/tournaments, /:id/stats)
│   ├── tournaments.js           # Routes tournois (GET /, /:id, /:id/matches, /:id/races)
│   ├── runs.js                  # Routes races (GET /, /:id avec filtres avancés)
│   ├── players.js               # Routes joueurs (GET /, /by-name/:name, /by-name/:name/races)
│   ├── sync.js                  # Sync Challonge + Racetime.gg (POST /tournament/:id, /races/:id)
│   ├── racetime.js              # Proxy Racetime.gg (avatars, find, twitch)
│   ├── streams.js               # API Twitch streams (GET /:gameId, GET /)
│   └── search.js                # Recherche globale multi-types (GET /?q=...)
├── services/
│   ├── challonge.js             # Client API Challonge (getTournament, getParticipants, getMatches)
│   └── racetime.js              # Client API Racetime.gg (getRace, findRaces, getUserProfile)
├── helpers/
│   └── findGameForTournament.js # Détection intelligente jeu depuis nom/description tournoi
├── scripts/
│   ├── seed-games.js            # Initialisation collection Games (10+ jeux)
│   ├── auto-link-races.js       # Liaison automatique races → matchs (heuristique)
│   ├── auto-link-races-global.js# Liaison race contre TOUS les matchs DB
│   ├── link-race-to-match.js    # Liaison manuelle forcée
│   ├── unlink-race.js           # Suppression liaison
│   ├── import-and-link-racetime.js # Import race + auto-link
│   ├── enrich-races.js          # Mise à jour races existantes
│   ├── import-player-marco.js   # Import joueurs spécifique
│   ├── backfill-populate-source.js # Migration métadonnées source
│   ├── migrations/              # Scripts migration DB (times, refs, etc.)
│   │   ├── migrate-add-game-ref.js
│   │   ├── migrate-convert-times.js
│   │   └── bulk-convert-finishTimes.js
│   ├── debug/                   # Outils debug (list-tournament-matches, print-sample-docs)
│   └── archived/                # Scripts legacy
├── public/
│   ├── index.html               # Page accueil (derniers tournois/races)
│   ├── games.html               # Liste jeux
│   ├── game-detail.html         # Détail jeu avec stats
│   ├── tournaments.html         # Liste tournois
│   ├── tournament-detail.html   # Détail tournoi (bracket, participants, matchs)
│   ├── races.html               # Liste races
│   ├── race-detail.html         # Détail race (classement, infos seed)
│   ├── players.html             # Liste joueurs
│   ├── player-detail.html       # Profil joueur (stats, historique)
│   ├── search.html              # Recherche globale
│   ├── style.css                # Styles globaux (dark theme, responsive)
│   ├── assets/                  # Images, logos, favicon
│   │   ├── favicon.png
│   │   ├── racetime.svg
│   │   └── game-logos/
│   └── js/
│       ├── api.js               # Client API centralisé (fetchJson, fetchWithCache)
│       ├── spoiler-mode.js      # Toggle anti-spoiler global + event dispatcher
│       ├── global-search.js     # Barre recherche avec autocomplete
│       ├── index.js             # Logic page accueil
│       ├── games.js             # Logic liste jeux
│       ├── game-detail.js       # Logic détail jeu
│       ├── tournaments.js       # Logic liste tournois
│       ├── tournament-detail.js # Logic détail tournoi (bracket rendering, phases groupes)
│       ├── races.js             # Logic liste races
│       ├── race-detail.js       # Logic détail race
│       ├── players.js           # Logic liste joueurs
│       ├── player-detail.js     # Logic profil joueur
│       └── search.js            # Logic page recherche
├── server.js                    # Serveur Express (middleware, routes, error handling)
├── package.json                 # Dépendances et scripts npm
├── .env.example                 # Template variables environnement
├── .env                         # Variables environnement (gitignored)
├── .gitignore                   # Fichiers exclus git
└── README.md                    # Documentation (ce fichier)
```

## 🔐 Sécurité

### 🛡️ Mesures de Protection Implémentées

**Protection contre les injections NoSQL**
- ✅ Sanitization automatique des inputs MongoDB (`express-mongo-sanitize`)
- ✅ Validation stricte des ObjectIds (regex pattern)
- ✅ Middleware `validateObjectId()` sur toutes les routes sensibles

**Protection SSRF (Server-Side Request Forgery)**
- ✅ Whitelist de domaines autorisés pour proxy d'images
- ✅ Blocage des IPs privées/internes (10.x, 192.168.x, 127.x, localhost)
- ✅ Validation URL avec bibliothèque `validator`
- ✅ Limite de taille d'image (5MB max)

**Rate Limiting (Protection DDoS)**
- ✅ API générale: 100 requêtes/15 minutes
- ✅ Recherche: 30 requêtes/minute
- ✅ Opérations d'écriture: 10 requêtes/heure
- ✅ Webhooks: 5 requêtes/minute
- ✅ Configuration `trust proxy` pour reverse proxy

**Gestion des erreurs sécurisée**
- ✅ Pas de stack traces exposées en production
- ✅ Logging structuré des erreurs (IP, URL, méthode)
- ✅ Messages génériques pour l'utilisateur

**Headers de sécurité (Helmet.js)**
- ✅ X-Frame-Options: SAMEORIGIN
- ✅ X-Content-Type-Options: nosniff
- ✅ X-XSS-Protection: 1; mode=block
- ✅ Content-Security-Policy configurée
- ✅ Permissions-Policy restrictive

**CORS configuré**
- ✅ Restreint aux domaines autorisés en production (randomizer.games)
- ✅ Ouvert uniquement en développement
- ✅ Credentials activés avec origines spécifiques

**Validation des inputs**
- ✅ Validation pagination (limit: 1-100, page: 1-10000)
- ✅ Sanitization des strings (suppression `<>`, limite longueur)
- ✅ Limite de taille des payloads (1MB)

**Sécurité des webhooks**
- ✅ Vérification HMAC SHA256 des signatures GitHub
- ✅ Timing-safe comparison (protection timing attack)
- ✅ Logging des tentatives de webhook

**Cache sécurisé**
- ✅ Limite de taille (50 entrées max)
- ✅ Nettoyage automatique des entrées expirées
- ✅ Éviction LRU (Least Recently Used)

### 🔍 Audit de Sécurité

**Script de vérification pré-déploiement**
```bash
npm run check-security
```

Vérifie:
- Variables d'environnement requises
- Dépendances de sécurité installées
- Configuration .gitignore
- Middleware de sécurité présent
- NODE_ENV en production

**Rapport d'audit complet**: Voir [SECURITY_AUDIT.md](SECURITY_AUDIT.md)

### 📋 Checklist Sécurité Production

**Avant déploiement**:
- [ ] `.env` configuré avec valeurs production
- [ ] `NODE_ENV=production`
- [ ] Secrets générés avec `openssl rand -hex 32`
- [ ] CORS restreint au domaine production
- [ ] Rate limiting activé
- [ ] Certificat SSL/HTTPS configuré
- [ ] Firewall (UFW) actif
- [ ] Fail2ban installé
- [ ] MongoDB avec authentification
- [ ] Backups automatisés configurés
- [ ] Script `npm run check-security` passe

**Guide complet**: Voir [DEPLOYMENT.md](DEPLOYMENT.md)

### 🚨 Recommandations Futures

**Haute priorité**:
1. Authentification API avec API keys
2. WAF (Web Application Firewall) - CloudFlare ou AWS WAF
3. Monitoring avec alertes (erreurs 5xx, rate limit dépassé)
4. Secrets Manager (AWS Secrets Manager, HashiCorp Vault)

**Priorité moyenne**:
5. Redis pour cache distribué
6. Audit logs pour opérations sensibles
7. Tests de sécurité automatisés (OWASP ZAP)

---

**🎯 Score de sécurité actuel: 8.5/10** (voir [SECURITY_AUDIT.md](SECURITY_AUDIT.md))

---

## 🎯 Différences avec Speedrun.com

| Aspect | Speedrun.com | Randomizer |
|--------|--------------|---------------|
| **Classement global de temps** | ✅ Leaderboards par catégorie | ❌ Pas pertinent (seeds aléatoires) |
| **Focus principal** | Records individuels | 🏆 Tournois et confrontations directes |
| **Catégories** | Fixes par jeu | ✅ Catégories + settings combinés |
| **Type de runs** | Runs solo vérifiés | ✅ Races compétitives en temps réel |
| **Leaderboards** | Par temps global | ✅ Brackets tournois et phases de poule |
| **Meilleur temps** | Record absolu | ✅ Meilleur temps par tournoi/seed |
| **Import auto** | Soumissions manuelles | ✅ Sync Challonge + Racetime.gg |
| **Vérification** | Modérateurs + vidéos | ✅ Données officielles Racetime.gg |
| **Phases** | Catégories/sous-catégories | ✅ Groupes + élimination directe |
| **Mode anti-spoiler** | ❌ Non | ✅ Toggle global dynamique |

## 🚧 Roadmap

### Fonctionnalités à venir
- [ ] **Bracket interactif SVG** : Visualisation graphique avancée (D3.js / Canvas)
- [ ] **Graphiques statistiques** : Chart.js pour évolution performances joueurs
- [ ] **Export données** : CSV, JSON, Excel (tournois, races, stats)
- [ ] **API publique documentée** : Swagger/OpenAPI avec rate limiting
- [ ] **Cache Redis** : Amélioration performances (remplace node-cache)
- [ ] **Webhooks Challonge** : Sync temps réel (push vs pull)
- [ ] **Authentification** : Comptes utilisateurs (login Racetime.gg OAuth)
- [ ] **Administration panel** : CRUD tournois/races, gestion liens
- [ ] **Notifications** : Discord/Twitch webhooks pour nouveaux tournois
- [ ] **Multi-langue** : i18n (FR/EN)
- [ ] **PWA** : Service workers pour offline + notifications

### Améliorations techniques
- [ ] **Tests unitaires** : Jest/Mocha pour routes et services
- [ ] **Tests E2E** : Playwright pour frontend
- [ ] **CI/CD** : GitHub Actions (lint, test, deploy)
- [ ] **Docker** : Containerisation (app + MongoDB)
- [ ] **Monitoring** : Prometheus + Grafana
- [ ] **Logs structurés** : Winston avec rotation

### Completed ✅
- [x] Mode anti-spoiler global dynamique
- [x] Recherche globale multi-types
- [x] Proxy avatars Racetime.gg
- [x] Détection streams Twitch en direct
- [x] Liaison automatique races ↔ matchs (heuristique)
- [x] Parsing intelligent des temps (ISO 8601, HH:MM:SS, ms)
- [x] Import Challonge avec sanitization HTML
- [x] Migrations DB avec scripts dédiés
- [x] Helper détection auto du jeu (tournoi)

## 📝 Licence

MIT License - Libre d'utilisation, modification et distribution.

## 👨‍💻 Auteur

**queled**

## 🙏 Remerciements

- **Challonge** : API pour données tournois
- **Racetime.gg** : API publique races et joueurs
- **Twitch** : API détection streams
- **Communauté Randomizer** : OOT, ALTTP, MM, KH2, et tous les speedrunners

## 📞 Support & Contribution

### Signaler un bug
- Ouvrir une issue GitHub avec :
  - Description du problème
  - Steps to reproduce
  - Logs serveur (`server.log`)
  - Version Node.js / MongoDB

### Proposer une fonctionnalité
- Ouvrir une issue GitHub avec :
  - Description de la feature
  - Cas d'usage
  - Maquettes/wireframes si applicable

### Contribuer au code
1. Fork le projet
2. Créer une branche feature (`git checkout -b feature/AmazingFeature`)
3. Commit les changements (`git commit -m 'Add AmazingFeature'`)
4. Push vers la branche (`git push origin feature/AmazingFeature`)
5. Ouvrir une Pull Request

### Guidelines
- Code style : ESLint recommandé
- Commits : Conventional Commits (feat:, fix:, docs:, etc.)
- Tests : Ajouter tests pour nouvelles fonctionnalités
- Documentation : Mettre à jour README si nécessaire

---

**Note importante** : Ce projet est en version 2.0 et utilise des APIs tierces (Challonge, Racetime.gg, Twitch). 
- Respectez les rate limits des APIs externes
- Challonge API : ~1 req/sec recommandé
- Twitch API : Token valide 60 jours (renouvellement auto)
- Racetime.gg : Pas de limite documentée, mais soyez raisonnable

**Disclaimer** : Ce projet n'est pas affilié à Challonge, Racetime.gg ou Twitch. Les données sont importées depuis leurs APIs publiques à des fins d'agrégation et de visualisation uniquement.
