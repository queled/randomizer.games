# Architecture

Comment les données arrivent dans le site, où elles sont stockées, et quels scripts les entretiennent.

## Vue d'ensemble

```
 rando-list (GitHub)   racetime.gg   SpeedRunsLive   start.gg   Challonge   speedrun.com   Twitch
        │                   │              │            │           │            │           │
        ▼                   ▼              ▼            ▼           ▼            ▼           ▼
 ┌───────────────────────────────────────────────────────────────────────────────────────────────┐
 │  scripts/  —  lancés par GitHub Actions (cron), depuis le panneau admin, ou à la main          │
 └───────────────────────────────────────────────────────────────────────────────────────────────┘
                                              │
                                              ▼
                     MongoDB : games · races · tournaments · matches · players
                                     + rando_list_cache
                                              │
                                              ▼
                       server.js (Express) : API /api/* + pages statiques public/
```

| Source | Ce qu'on en tire |
|--------|------------------|
| [rando-list](https://github.com/video-game-randomizers/rando-list) | Liste des jeux et randomizers, sites officiels |
| racetime.gg | Courses (en continu) et catégories de jeux |
| SpeedRunsLive | Historique des courses d'avant racetime.gg (import ponctuel) |
| start.gg / Challonge | Tournois, participants, matchs |
| speedrun.com | Plateformes, date de sortie, images des jeux |
| Twitch | Streams en direct, identifiants des jeux |

## Workflows GitHub Actions

Tous les workflows tournent sur Node 20 et écrivent directement dans la base de production via le secret `MONGODB_URI`. La base doit donc être joignable depuis Internet (MongoDB Atlas, par exemple).

| Workflow | Fréquence | Ce qu'il fait |
|----------|-----------|---------------|
| `sync-racetime.yml` | toutes les 5 min | `sync-racetime-global.js` : nouvelles courses, finalisation des courses bloquées « en cours » depuis plus de 24 h, rattrapage des courses terminées entre deux exécutions |
| `sync-racetime-game-full.yml` | manuel | `sync-racetime-game.js` : resynchronisation complète d'un jeu (paramètres `game_slug`, `max_pages`) |
| `sync-rando-list.yml` | tous les jours à 6h UTC | `check-rando-list-changes.js` vérifie si rando-list a changé ; si oui, `sync-rando-list.js --detect-new` met à jour le cache et les ressources, puis signale les nouveaux jeux, à créer depuis le panneau admin |
| `sync-tournaments-discover.yml` | tous les jours à 7h UTC | `discover-tournaments.js` : cherche de nouveaux tournois sur start.gg et Challonge (paramètres `dry_run`, `source`, `days`) |
| `sync-tournaments-update.yml` | toutes les 15 min | `sync-tournaments.js --update-only` met à jour les tournois actifs, puis `auto-link-tournaments.js` rattache les courses aux matchs |

Chaque workflow peut aussi être lancé à la main depuis l'onglet **Actions**. Le panneau admin affiche leur état si `GITHUB_TOKEN` et `GITHUB_REPO` sont renseignés.

### Secrets et variables du dépôt

*Settings → Secrets and variables → Actions*

| Nom | Type | Utilisé par |
|-----|------|-------------|
| `MONGODB_URI` | secret | tous les workflows |
| `STARTGG_API_TOKEN` | secret | workflows tournois |
| `CHALLONGE_API_KEY` | secret | workflows tournois |
| `RACETIME_RATE_LIMIT_MS` | variable (facultative) | workflows racetime ; délai entre deux requêtes, 1500 ms par défaut |

## Détection des tournois

`discover-tournaments.js` retient un tournoi s'il correspond à :

1. des mots-clés génériques : `randomizer`, `randomiser`, `rando`, `multiworld`, `archipelago`…
2. les noms des jeux présents en base (nom, acronymes) ;
3. le jeu déclaré sur start.gg ou Challonge.

`helpers/findGameForTournament.js` associe ensuite le tournoi à un jeu du site. Les tournois déjà présents en base ne sont pas réimportés.

Les courses sont rattachées aux matchs par `services/tournament-autolink.js` (score de confiance) et aux qualifications par `services/tournament-qualifiers.js`. Le panneau admin permet de vérifier ou de corriger ces liens.

## Modèle de données

Les schémas sont dans [`models/index.js`](../models/index.js).

| Collection | Contenu |
|------------|---------|
| `games` | Un jeu randomizer, ses ressources et ses intégrations externes |
| `races` | Une course (racetime.gg ou SpeedRunsLive, URL `/srl/<id>`) |
| `tournaments` | Un tournoi start.gg ou Challonge, ses phases et ses participants |
| `matches` | Un match de tournoi et les courses qui y sont liées |
| `players` | Un joueur, avec ses alias (pseudos utilisés ailleurs) |
| `rando_list_cache` | Copie brute de rando-list et métadonnées de la dernière synchronisation |

### Jeux (`games`)

```
id                 identifiant interne, unique et immuable (ex. "alttp")
name               nom court du jeu
official           { name, releaseDate, releaseYear, website }   — le jeu d'origine
randomizer         { displayName, shortName, tinyName, name, website, opensource, addedDate, updatedDate }
resources          { officialSite, sites[], trackers[], guides[], other[] }
platforms[], series, logo, image, categories[]
integrations       { randoList, racetime, speedrun, twitch, startgg, challonge }
source             { origin: seed | csv-import | rando-list | manual, importedAt }
enabled
```

Deux règles protègent les données saisies à la main :

- **L'`id` interne fait foi.** Les identifiants externes (slug racetime, id speedrun.com…) sont rangés dans `integrations.*` et ne le remplacent jamais.
- **`confidence: 'manual'` n'est jamais écrasé.** Chaque intégration porte un champ `confidence` : `auto` (trouvé par un script, peut être mis à jour) ou `manual` (fixé par un admin, laissé tel quel par les scripts).

À l'affichage, la page d'un jeu prend `randomizer.displayName` comme titre et `official.name` comme sous-titre. Le bouton « Site officiel » (ou « Archipelago ») vient de `resources.officialSite`, ou du seul site connu s'il n'y en a qu'un.

## Scripts

Les scripts qui écrivent en base proposent un mode `--dry-run` (ou n'écrivent qu'avec `--apply`) : lire l'en-tête de chaque fichier pour les options.

### Synchronisation (récurrents)

| Script | Commande npm | Rôle |
|--------|--------------|------|
| `sync-racetime-global.js` | `sync:racetime` | Nouvelles courses racetime.gg (workflow 5 min) |
| `sync-racetime-game.js` | — | Toutes les courses d'un jeu (workflow manuel, admin) |
| `sync-rando-list.js` | `sync-rando-list`, `:detect`, `:link` | Cache rando-list, ressources, nouveaux jeux |
| `check-rando-list-changes.js` | — | Indique au workflow si rando-list a changé |
| `discover-tournaments.js` | `discover:tournaments` (+ `:dry`, `:startgg`, `:challonge`) | Découverte de tournois |
| `sync-tournaments.js` | `sync:tournaments` (+ `:dry`, `:update`) | Mise à jour des tournois actifs |
| `auto-link-tournaments.js` | `link:tournaments:active` | Rattache les courses aux matchs |
| `sync-players-from-races.js` | `sync:players` (+ `:dry`) | Recalcule la collection des joueurs |

`npm run sync` enchaîne racetime, joueurs et rando-list.

### Import et enrichissement (à la demande)

| Script | Commande npm | Rôle |
|--------|--------------|------|
| `import-startgg.js` | `import:startgg <url>` | Importe un tournoi start.gg |
| `import-challonge.js` | `import:challonge <id>` | Importe un tournoi Challonge |
| `link-startgg-races.js` | `link:startgg-races <id>` | Lie les courses aux sets start.gg |
| `link-challonge-races.js` | `link:challonge-races <id>` | Lie les courses aux matchs Challonge |
| `link-qualifier-races.js` | `link:qualifiers` | Rattache les courses de qualification |
| `sync-speedrunslive.js` | `sync:speedrunslive` | Historique SpeedRunsLive |
| `enrich-games.js` | `enrich-games` | Complète les jeux via speedrun.com et racetime.gg |
| `enrich-twitch.js` | — | Associe les jeux à leurs catégories Twitch |
| `import-games-csv.js` | `import-games <fichier.csv>` | Import de jeux depuis un CSV (modèle : [`data/games-template.csv`](../data/games-template.csv)) |
| `import-multiworld-manual.js` | `import:multiworld-manual` | Marque les jeux disponibles sur Archipelago / Multiworld |

### Maintenance

| Script | Commande npm | Rôle |
|--------|--------------|------|
| `unlink-race.js` | — | Détache une course de son match (aussi depuis l'admin) |
| `migrations/*.js` | — | Migrations ponctuelles, idempotentes |
| `backup-db.js` | `db:backup` | Export JSON de toutes les collections dans `backups/` |
| `check-security.js` | `check-security` | Vérifications avant déploiement (lancé par `predeploy`) |

### Format du CSV de jeux

Une ligne par jeu, avec les colonnes de [`data/games-template.csv`](../data/games-template.csv) :

| Colonne | Champ |
|---------|-------|
| `my id` | `id` |
| `game name` | `name` |
| `full game name` | `official.name` |
| `shortname rando` | `randomizer.shortName` |
| `official rando name` | `randomizer.displayName` |
| `full rando name` | `randomizer.name` |
| `id game speedrun.com` | `integrations.speedrun.gameId` |
| `id rando racetime.gg` | `integrations.racetime.gameSlug` |
| `very shortname rando racetime.gg` | `integrations.racetime.gameName` |
| `année de sortie du jeu` | `official.releaseDate` (1er janvier de l'année) |
| `série` | `series` |
| `plateforme` | `platforms` (séparées par des virgules) |

```bash
node scripts/import-games-csv.js data/games.csv --dry-run    # aperçu
node scripts/import-games-csv.js data/games.csv --link-only  # ajoute les intégrations sans rien écraser
node scripts/import-games-csv.js data/games.csv --full       # import complet (écrase)
```
