# 🎮 Randomizer.Games

Plateforme centralisée pour agréger et exposer des données de tournois/courses randomizer (Racetime, Challonge, Speedrun.com, Twitch).

## Prérequis

- Node.js 18+
- MongoDB 4.4+

## Installation

```bash
git clone https://github.com/queled/randomizer.games.git
cd randomizer.games
npm install
cp .env.example .env
```

Renseigner au minimum dans `.env` :

- `MONGODB_URI`
- `ADMIN_TOKEN` (obligatoire en production)

## Lancement

```bash
npm start
```

Application disponible sur `http://localhost:3000`.

## Scripts utiles

```bash
# Sync principal (Racetime + Rando-list)
npm run sync

# Sync Racetime
npm run sync:racetime

# Sync Rando-list
npm run sync-rando-list
npm run sync-rando-list:detect
npm run sync-rando-list:link

# Import/enrichissement
npm run import-games
npm run enrich-games

# Vérifications sécurité pré-déploiement
npm run check-security
```

## Sécurité

Le backend applique notamment :

- `helmet`
- `cors` (restreint en production)
- `express-rate-limit`
- `express-mongo-sanitize`
- validation stricte pagination et URLs proxifiées

Le proxy image applique une allowlist de domaines et des limites de taille/timeout.

## Documentation

- `docs/AUTOMATION.md`
- `docs/GAME_SYNC_ARCHITECTURE.md`
- `docs/DEPLOYMENT.md`
- `docs/SECURITY_AUDIT.md`
- `docs/SECURITY_FIXES.md`

## Structure

- `server.js` : entrée Express
- `routes/` : endpoints API
- `middleware/` : sécurité + auth admin
- `models/` : schémas MongoDB
- `scripts/` : imports, sync, maintenance
- `public/` : pages statiques + panneau admin

## API namespaces (sans versioning)

L'API reste **hybride** (REST + endpoints opérationnels) avec des namespaces canoniques :

- `GET/CRUD` ressources : `/api/games`, `/api/tournaments`, `/api/runs`, `/api/players`, `/api/streams`
- `commands` (opérations déclenchées) : `/api/commands/sync/*`
- `hooks` (webhooks entrants) : `/api/hooks/rando-list/*`
- `services` (intégrations externes/proxy) : `/api/services/racetime/*`, `/api/services/proxy-image`
- `queries` (recherche/agrégations) : `/api/queries/search`

Les anciens endpoints (`/api/sync`, `/api/sync-rando-list`, `/api/racetime`, `/api/proxy-image`, `/api/search`) restent supportés pour éviter toute casse des scripts/workflows existants.

## Contribution

Voir `CONTRIBUTING.md`.

## Licence

MIT — voir `LICENSE`.
