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
| [Mido's House](https://midos.house) | Horaires et restreams des races des tournois OoTR |
| speedrun.com | Plateformes, date de sortie, images des jeux |
| Twitch | Streams en direct, identifiants des jeux, VOD des restreams |

## Tâches planifiées

En production, la base MongoDB tourne sur le même serveur que le site et n'écoute que sur `127.0.0.1`. Les synchronisations sont lancées par la crontab du serveur via [`scripts/cron/run-job.sh`](../scripts/cron/run-job.sh), qui pose un verrou par tâche (une exécution encore en cours n'est pas doublée), limite leur durée et écrit dans `~/logs/<tâche>.log`. La crontab elle-même est dans [DEPLOYMENT.md](DEPLOYMENT.md#6-tâches-planifiées).

| Tâche | Fréquence (UTC) | Ce qu'elle fait |
|-------|-----------------|-----------------|
| `racetime` | toutes les 5 min | `sync-racetime-global.js` : nouvelles courses, finalisation des courses bloquées « en cours » depuis plus de 24 h, rattrapage des courses terminées entre deux exécutions |
| `tournaments-update` | toutes les 15 min | `sync-tournaments.js --update-only` met à jour les tournois actifs, puis `auto-link-tournaments.js` rattache les courses aux matchs |
| `race-vods` | toutes les 30 min | `sync-race-vods.js` : VOD Twitch des joueurs des races de tournoi (voir plus bas) |
| `midos-house` | toutes les 15 min | `sync-midos-house.js` : horaires et restreams des races des tournois OoTR, VOD Twitch des restreams (voir plus bas) |
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

`sync-midos-house.js` range ces races sur le tournoi start.gg correspondant (trouvé par son `startggSlug`), dans un champ à part de `matches`, que la synchronisation start.gg reconstruit à chaque passage :

- `midosHouse.schedule` : les races à venir, remplacées à chaque exécution. Une race jouée en sort, et un événement qui quitte l'accueil de Mido's House voit sa liste vidée.
- `midosHouse.pastRestreams` : les races jouées qui ont eu un restream, gardées une fois l'événement terminé.

Une race encore listée « à venir » 12 h après son heure compte comme jouée : la page d'un événement terminé n'a qu'un seul tableau, sans titre « Past races ».

Le script cherche ensuite la VOD de chaque restream joué, de trois façons :

1. **Lien de Mido's House** : pour les anciens événements, Mido's House donne souvent la vidéo elle-même (`twitch.tv/videos/…`, YouTube) au lieu de la chaîne. Elle devient la VOD, et la chaîne de la vidéo Twitch, demandée à Twitch, garde la trace de qui a restreamé. Le lien d'origine reste dans `sourceUrl`.
2. **Rediffusion Twitch** (`services/twitch-vods.js`, avec `TWITCH_CLIENT_ID` et `TWITCH_CLIENT_SECRET`) : pour les restreams joués depuis moins de 60 jours, la diffusion en cours à l'heure de départ de la race racetime.gg (ou à l'heure prévue si la race n'est pas en base). Le lien pointe sur ce moment de la vidéo.
3. **Temps forts et vidéos mises en ligne** : Twitch les garde sans limite de durée. Une vidéo de la chaîne convient si son titre contient le nom des deux joueurs (pseudo Mido's House ou start.gg), si elle a été créée après la race, et si le titre ne nomme ni un autre tournoi ni une autre saison. Pour une série en plusieurs races, le numéro de manche (`game`, calculé dans l'ordre des races du set) doit correspondre au « Game N » du titre. En routine, seules les races des 60 derniers jours sont cherchées ; `--archive` les cherche toutes.

Twitch efface les rediffusions au bout de 7 à 60 jours selon la chaîne (ou plus tôt, si le streamer les supprime). À chaque exécution, le script vérifie que les VOD Twitch trouvées sont encore en ligne : une VOD disparue perd son lien (`vodUrl`) et reçoit `vodGoneAt`, mais le restream garde sa chaîne et sa langue, et la page renvoie alors vers la chaîne.

`GET /api/tournaments/:id/matches` ajoute `scheduledAt` et `restreams` (avec `vodUrl`) à chaque match. L'onglet Restream de la page d'un tournoi liste les races à venir et jouées qui ont un restream, filtrables par langue.

Pour reprendre les événements terminés (une seule fois) : `node scripts/sync-midos-house.js --archive`.

Un événement sans sets start.gg (Challonge, bracket géré sur Mido's House) est rattaché au tournoi auquel sont liées ses races racetime.gg, si au moins 5 d'entre elles (et un tiers de ses rooms) y mènent : c'est le cas des Standard S6 et S7 et des RSL S2 et S3. Les restreams y sont reliés aux matchs par leur room racetime.gg. Les autres événements (Tournoi Francophone, Scrubs, SpeedGaming, league…) n'ont pas de tournoi en base et sont ignorés.

### VOD des joueurs

Les joueurs de tournoi streament leurs races. `sync-race-vods.js` prend les races de tournoi terminées (liées à un tournoi ou à un set start.gg), lit sur racetime.gg la chaîne Twitch de chaque joueur (`/data` de la race) et cherche la rediffusion en cours au départ de la race, avec un lien sur ce moment de la vidéo. Le résultat est rangé dans `race.vods` (`userId`, `userName`, `twitchName`, `vodUrl`), à part de `entrants`, que la synchronisation racetime.gg réécrit. Une race est cherchée jusqu'à 12 h après sa fin (`vodSearchedAt`), puis laissée de côté.

À chaque exécution, les VOD trouvées sont vérifiées : une VOD que Twitch a supprimée perd son lien et reçoit `vodGoneAt`, la chaîne reste. La page d'une race affiche un bouton VOD à côté de chaque joueur, et les cartes de match de la page d'un tournoi un bouton par joueur à côté du lien racetime.gg.

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
| `sync-race-vods.js` | `sync:race-vods` (+ `:dry`) | VOD Twitch des joueurs des races de tournoi (tâche `race-vods`) |
| `sync-midos-house.js` | `sync:midos-house` (+ `:dry`) | Horaires, restreams et VOD Mido's House (tâche `midos-house`) |

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
