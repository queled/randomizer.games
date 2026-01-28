# 🎮 Randomizer.Games

> Une plateforme centralisée pour les tournois de randomizer - Agrégatrice de données Challonge, Racetime.gg et Speedrun.com

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D16.0.0-brightgreen)](https://nodejs.org/)
[![MongoDB Version](https://img.shields.io/badge/MongoDB-%3E%3D4.4-green)](https://www.mongodb.com/)

## 🌟 Fonctionnalités principales

### 🏆 Tournois
- Import automatique depuis **Challonge** (brackets, matchs, participants)
- Support multi-formats (élimination simple/double, round-robin, swiss, groupes)
- Liaison intelligente race ↔ match avec scoring heuristique
- Interface interactive avec visualisation de brackets

### 🎯 Races & Résultats
- Synchronisation **Racetime.gg** en temps réel
- Parsing intelligent des temps (ISO 8601, HH:MM:SS, ms)
- Tracking statuts (done, dnf, dq, in_progress)
- Classement avec médailles 🥇🥈🥉

### 👥 Profils Joueurs
- Agrégation multi-sources (Racetime, Challonge)
- Statistiques : courses, victoires, meilleur temps
- Historique complet des participations
- Intégration avatars et streams Twitch

### 🔍 Recherche & Navigation
- Recherche multi-critères globale
- Normalisation intelligente (accents, variantes)
- Mode anti-spoiler 🙈 (toggle per-session)

### 🎮 Games Library
- Base de données centralisée (ALttP, OoT, MM, KH2FM, etc.)
- Intégrations : Racetime, Speedrun.com, Rando-list
- Enrichissement automatique des données

## 🏗️ Stack Technique

```
Frontend:  HTML5 + CSS3 + Vanilla JS
Backend:   Node.js + Express 4.18
Database:  MongoDB 4.4+
APIs:      Challonge v1, Racetime.gg, Twitch Helix, Speedrun.com
Caching:   Node-cache (5min TTL)
Security:  Helmet, CORS, Input sanitization
```

## 🚀 Installation rapide

### Prérequis
- Node.js v16+
- MongoDB v4.4+
- npm/yarn

### Setup

```bash
# 1. Cloner et installer
git clone https://github.com/queled/randomizer.games.git
cd randomizer.games
npm install

# 2. Configuration
cp .env.example .env
# Éditer .env avec vos API keys (Challonge, Twitch)

# 3. Démarrer
npm start
# Visite http://localhost:3000
```

### Variables d'environnement `.env`

```env
# Database
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/randomizer

# Challonge API
CHALLONGE_API_KEY=your_key_here
CHALLONGE_USERNAME=your_username

# Twitch API (optionnel)
TWITCH_CLIENT_ID=your_client_id
TWITCH_CLIENT_SECRET=your_client_secret

# Server
PORT=3000
NODE_ENV=development
ADMIN_TOKEN=your_secret_token
```

**Obtenir les clés** :
- **Challonge** : https://challonge.com → Settings → Developer API
- **Twitch** : https://dev.twitch.tv/console/apps
- **MongoDB** : https://www.mongodb.com/cloud/atlas

## 📚 Documentation

Pour une documentation complète :

| Sujet | Fichier |
|-------|---------|
| Architecture système | [`docs/GAME_SYNC_ARCHITECTURE.md`](docs/GAME_SYNC_ARCHITECTURE.md) |
| Automatisation (Cron, GitHub Actions) | [`docs/AUTOMATION.md`](docs/AUTOMATION.md) |
| Déploiement production | [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) |
| Corrections & migrations | [`docs/CORRECTIONS.md`](docs/CORRECTIONS.md) |

## 📡 API Endpoints (sélection)

```
GET  /api/games              # Liste tous les jeux
GET  /api/games/:id          # Détails d'un jeu
GET  /api/tournaments        # Tous les tournois
GET  /api/tournaments/:id    # Détails tournoi + matches
GET  /api/races              # Toutes les races
GET  /api/players            # Profils joueurs
GET  /api/search?q=...       # Recherche globale
POST /api/sync/race          # Sync Racetime (webhook)
POST /api/sync/tournament    # Sync Challonge (webhook)
```

Voir [`server.js`](server.js) et [`routes/`](routes/) pour la liste complète.

## 🔄 Synchronisation automatique

Deux syncs quotidiennes via GitHub Actions :

1. **Racetime.gg** (4h) : Races en direct + avatars
2. **Rando-list** (2h) : Métadonnées des randomizers

```bash
# Lancer manuellement
npm run sync:racetime
npm run sync:rando-list
```

Voir [`docs/AUTOMATION.md`](docs/AUTOMATION.md) pour plus de détails.

## 📁 Structure du projet

```
├── public/              # Frontend HTML/CSS/JS
│   ├── index.html       # Accueil
│   ├── js/              # Modules JS (api, spoiler-mode, etc.)
│   └── admin/           # Panneau admin privé
├── routes/              # Endpoints API Express
├── models/              # Schémas Mongoose
├── scripts/             # Utilitaires et syncs
│   ├── import-games-csv.js
│   ├── sync-racetime-*.js
│   ├── sync-rando-list-*.js
│   └── migrations/      # Migrations DB
├── services/            # Intégrations externes (Racetime, Challonge, Twitch)
├── middleware/          # Auth, security, etc.
├── config/              # Configuration
├── docs/                # Documentation
└── server.js            # Entrée principale
```

## 🔐 Sécurité

- ✅ Helmet (headers de sécurité)
- ✅ CORS restrictif
- ✅ CSRF protection (tokens)
- ✅ Sanitization HTML (Challonge)
- ✅ Rate limiting (optional)
- ✅ Admin authentication (token)
- ✅ Validation input
- ⚠️ MongoDB injection prevention

Voir [`docs/SECURITY_AUDIT.md`](docs/SECURITY_AUDIT.md) pour l'audit complet.

## 🧪 Tests

```bash
npm run test              # Tous les tests
npm run test:integration  # Tests intégration
npm run test:coverage     # Couverture
```

## 🤝 Contribution

Les contributions sont bienvenues ! Voir [`CONTRIBUTING.md`](CONTRIBUTING.md) pour les guidelines.

## 📄 Licence

MIT © 2024 - Voir [`LICENSE`](LICENSE)

## 👨‍💻 Auteur

[queled](https://github.com/queled)

## 📞 Support

- Issues : [GitHub Issues](https://github.com/queled/randomizer.games/issues)
- Discussions : [GitHub Discussions](https://github.com/queled/randomizer.games/discussions)
- Email : contact@randomizer.games

---

**Built with ❤️ for the randomizer community**
