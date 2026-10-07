# Architecture

Comment les données arrivent dans le site, où elles sont stockées, et quels scripts les entretiennent.

## Vue d'ensemble

```
 rando-list (GitHub)   racetime.gg   SpeedRunsLive   start.gg   Challonge   speedrun.com   Twitch
        │                   │              │            │           │            │           │
        ▼                   ▼              ▼            ▼           ▼            ▼           ▼
 ┌───────────────────────────────────────────────────────────────────────────────────────────────┐
 │  scripts/  —  lancés par la crontab du serveur, depuis le panneau admin, ou à la main          │
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
| [Mido's House](https://midos.house) | Horaires et restreams des races à venir des tournois OoTR |
| speedrun.com | Plateformes, date de sortie, images des jeux |
| Twitch | Streams en direct, identifiants des jeux |

## Tâches planifiées

En production, la base MongoDB tourne sur le même serveur que le site et n'écoute que sur `127.0.0.1`. Les synchronisations sont lancées par la crontab du serveur via [`scripts/cron/run-job.sh`](../scripts/cron/run-job.sh), qui pose un verrou par tâche (une exécution encore en cours n'est pas doublée), limite leur durée et écrit dans `~/logs/<tâche>.log`. La crontab elle-même est dans [DEPLOYMENT.md](DEPLOYMENT.md#6-tâches-planifiées).

| Tâche | Fréquence (UTC) | Ce qu'elle fait |
|-------|-----------------|-----------------|
| `racetime` | toutes les 5 min | `sync-racetime-global.js` : nouvelles courses, finalisation des courses bloquées « en cours » depuis plus de 24 h, rattrapage des courses terminées entre deux exécutions |
| `tournaments-update` | toutes les 15 min | `sync-tournaments.js --update-only` met à jour les tournois actifs, puis `auto-link-tournaments.js` rattache les courses aux matchs |
| `midos-house` | toutes les 15 min | `sync-midos-house.js` : horaires et restreams des races à venir des tournois OoTR (voir plus bas) |
| `rando-list` | tous les jours à 6h | met à jour la copie locale de rando-list ; si `check-rando-list-changes.js` signale un nouveau commit, `sync-rando-list.js --detect-new` met à jour le cache et les ressources, puis signale les nouveaux jeux, à créer depuis le panneau admin |
| `tournaments-discover` | tous les jours à 7h | `discover-tournaments.js --since <il y a 2 jours> --max-pages 3` : nouveaux tournois sur start.gg et Challonge |
| `backup` | tous les jours à 3h30 | `backup-db.js` : archive `mongodump` de la base, 7 gardées |

Chaque tâche se lance aussi à la main : `scripts/cron/run-job.sh <tâche>`. Pour resynchroniser entièrement un jeu : `node scripts/sync-racetime-game.js --game <slug> [--max-pages N]`.

### Anciens workflows GitHub Actions

Les workflows de `.github/workflows/` faisaient le même travail depuis les serveurs de GitHub, à une époque où la base était hébergée sur MongoDB Atlas. Ils ne peuvent pas joindre une base fermée au réseau : ils sont désactivés depuis l'onglet **Actions** au passage sur le serveur, et gardés dans le dépôt le temps de la transition. Ils utilisent les secrets `MONGODB_URI`, `STARTGG_API_TOKEN` et `CHALLONGE_API_KEY` et la variable facultative `RACETIME_RATE_LIMIT_MS`. Le panneau admin affiche leur dernier état si `GITHUB_TOKEN` et `GITHUB_REPO` sont renseignés.

## Détection des tournois

`discover-tournaments.js` retient un tournoi s'il correspond à :

1. des mots-clés génériques : `randomizer`, `randomiser`, `rando`, `multiworld`, `archipelago`…
2. les noms des jeux présents en base (nom, acronymes) ;
3. le jeu déclaré sur start.gg ou Challonge.

`helpers/findGameForTournament.js` associe ensuite le tournoi à un jeu du site. Les tournois déjà présents en base ne sont pas réimportés.

Les courses sont rattachées aux matchs par `services/tournament-autolink.js` (score de confiance) et aux qualifications par `services/tournament-qualifiers.js`. Le panneau admin permet de vérifier ou de corriger ces liens.

### Horaires Mido's House

Les joueurs des tournois OoTR fixent l'horaire de leurs races sur [Mido's House](https://midos.house) (commande `/schedule` du bot Discord, dans le serveur du tournoi) et les restreamers y ajoutent leur chaîne, par langue. Son API GraphQL ne donne ni les liens de restream ni les sets start.gg : `services/midos-house.js` lit donc la page `/event/<série>/<édition>/races` de chaque événement listé sur l'accueil, et y prend l'heure de départ, le lien du set start.gg et les liens « <Langue> restream ».

`sync-midos-house.js` range ces races dans `tournament.midosHouse.schedule` du tournoi start.gg correspondant (trouvé par son `startggSlug`). Ce champ est à part de `matches`, que la synchronisation start.gg reconstruit à chaque passage. La liste est remplacée à chaque exécution : une race jouée en sort, et un événement qui quitte l'accueil de Mido's House voit sa liste vidée. `GET /api/tournaments/:id/matches` y ajoute `scheduledAt` et `restreams` pour chaque match pas encore terminé.

Les événements sans sets start.gg (Challonge, league, brackets gérés sur Mido's House) sont ignorés.

## Modèle de données

Les schémas sont dans [`models/index.js`](../models/index.js).

| Collection | Contenu |
|------------|---------|
| `games` | Un jeu randomizer, ses ressources et ses intégrations externes |
| `races` | Une course (racetime.gg ou SpeedRunsLive, URL `/srl/<id>`) |
| `tournaments` | Un tournoi start.gg ou Challonge, ses phases, ses participants et, pour OoTR, ses races planifiées sur Mido's House |
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
| `sync-racetime-global.js` | `sync:racetime` | Nouvelles courses racetime.gg (tâche `racetime`) |
| `sync-racetime-game.js` | — | Toutes les courses d'un jeu (à la main, admin) |
| `sync-rando-list.js` | `sync-rando-list`, `:detect`, `:link` | Cache rando-list, ressources, nouveaux jeux |
| `check-rando-list-changes.js` | — | Indique à la tâche `rando-list` si rando-list a changé |
| `discover-tournaments.js` | `discover:tournaments` (+ `:dry`, `:startgg`, `:challonge`) | Découverte de tournois |
| `sync-tournaments.js` | `sync:tournaments` (+ `:dry`, `:update`) | Mise à jour des tournois actifs |
| `auto-link-tournaments.js` | `link:tournaments:active` | Rattache les courses aux matchs |
| `sync-players-from-races.js` | `sync:players` (+ `:dry`) | Recalcule la collection des joueurs |
| `sync-midos-house.js` | `sync:midos-house` (+ `:dry`) | Horaires et restreams Mido's House (tâche `midos-house`) |

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
| `backup-db.js` | `db:backup` | Archive `mongodump` de la base dans `backups/` (`BACKUP_DIR`), les `BACKUP_KEEP` plus récentes gardées (7 par défaut) |
| `check-security.js` | `check-security` | Vérifications avant déploiement (lancé par `predeploy`) |
| `cron/run-job.sh` | — | Lance une tâche planifiée avec verrou, durée maximale et journal |

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
