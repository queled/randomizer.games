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
| [archipelago.gg](https://archipelago.gg/games) / [multiworld.gg](https://multiworld.gg/games) | Jeux jouables en multiworld Archipelago : pages, guides d'installation, wiki |
| [Tableur des APWorlds communautaires](https://docs.google.com/spreadsheets/d/1iuzDTOAvdoNe8Ne8i461qGNucg5OuEoF-Ikqs8aUQZw/edit) | Mondes distribués hors d'Archipelago : téléchargement, stabilité, trackers, guides, fil Discord |
| racetime.gg | Courses (en continu) et catégories de jeux |
| SpeedRunsLive | Historique des courses d'avant racetime.gg (import ponctuel) |
| start.gg / Challonge | Tournois, participants, matchs |
| [Mido's House](https://midos.house) | Horaires et restreams des races des tournois OoTR |
| [Hyrule Town Hall](https://hyruletownhall.com) | Le même outil pour d'autres jeux Zelda (ALTTPR, TWWR, MMR…) : horaires, restreams et nouveaux tournois |
| [SpeedGaming](https://speedgaming.org) | Liens des brackets (Challonge, start.gg) des tournois qu'il restreame |
| [ALTTPR League](https://alttprleague.com) | Saisons de la ligue par équipes ALTTPR (Invitational, et Open sur open.alttprleague.com) : équipes, divisions, matchs et temps |
| [GDQ](https://tracker.gamesdonequick.com) | Runs randomizer des marathons Games Done Quick et leur VOD YouTube |
| [Speedrace](https://speedrace.deeplydevs.com) | VOD saisies par les restreamers de quelques tournois OoTR |
| [alttp.localhorst.tv](https://alttp.localhorst.tv) | Planning communautaire ALTTPR, Super Metroid Rando et SMZ3 (surtout allemand) : chaînes de restream de chaque room racetime.gg |
| Calendriers iCal | Plannings publics des chaînes de restream (ZeldaSpeedRuns FR et DE) : restreams des matchs, retrouvés sur racetime.gg |
| [ALttPR Asyncs](https://alttprasyncs.com) | Séries de seeds async ALTTPR : entraînements des tournois, qualifs live et leurs résultats async |
| speedrun.com | Plateformes, date de sortie, images des jeux |
| Twitch | Streams en direct, identifiants des jeux, VOD des restreams |

## Tâches planifiées

En production, la base MongoDB tourne sur le même serveur que le site et n'écoute que sur `127.0.0.1`. Les synchronisations sont lancées par la crontab du serveur via [`scripts/cron/run-job.sh`](../scripts/cron/run-job.sh), qui pose un verrou par tâche (une exécution encore en cours n'est pas doublée), limite leur durée et écrit dans `~/logs/<tâche>.log`. La crontab elle-même est dans [DEPLOYMENT.md](DEPLOYMENT.md#6-tâches-planifiées). L'ordre des étapes et leur relance à la main sur une période sont dans [SYNC-WORKFLOW.md](SYNC-WORKFLOW.md).

| Tâche | Fréquence (UTC) | Ce qu'elle fait |
|-------|-----------------|-----------------|
| `racetime` | toutes les 5 min | `sync-racetime-global.js` : nouvelles courses, finalisation des courses bloquées « en cours » depuis plus de 24 h, rattrapage des courses terminées entre deux exécutions |
| `tournaments-update` | toutes les 15 min | `sync-tournaments.js --update-only` met à jour les tournois actifs, puis `auto-link-tournaments.js` rattache les courses aux matchs, et les tie-breaks de poule (room « tie-break » entre joueurs d'une même poule) à leur poule |
| `race-vods` | toutes les 30 min | `sync-race-vods.js` : VOD Twitch des joueurs de chaque race, puis `sync-race-restreams.js` : restreams absents de Mido's House, trouvés par le titre Twitch (voir plus bas) |
| `schedule-sites` | toutes les 15 min | `sync-schedule-sites.js` : horaires et restreams des races des tournois de Mido's House et Hyrule Town Hall, rattachement des courses par leur room, VOD Twitch des restreams, puis `sync-midos-league.js --current` : saison en cours de l'OoTR League, puis `sync-speedrace.js` : VOD saisies sur Speedrace, puis `sync-localhorst.js` : restreams planifiés sur localhorst, puis `sync-ical-restreams.js` : restreams des calendriers iCal (voir plus bas) |
| `rando-list` | tous les jours à 6h | met à jour la copie locale de rando-list ; si `check-rando-list-changes.js` signale un nouveau commit, `sync-rando-list.js --detect-new` met à jour le cache et les ressources, puis signale les nouveaux jeux, à créer depuis le panneau admin |
| `archipelago` | tous les jours à 6h20 | `sync-archipelago-games.js` : jeux listés sur [archipelago.gg](https://archipelago.gg/games) et [multiworld.gg](https://multiworld.gg/games) ; ajoute à chaque jeu sa page sur ces sites, le guide d'installation et le wiki (page vérifiée sur le wiki, titre corrigé ou lien retiré quand elle n'existe pas), crée les jeux absents (puis catégorie Twitch et année de sortie) et retire les liens des jeux qui en sont partis, puis `sync-community-apworlds.js` : APWorlds du tableur communautaire (voir plus bas) |
| `tournaments-discover` | tous les jours à 7h | `discover-tournaments.js --since <il y a 2 jours> --max-pages 3` : nouveaux tournois sur start.gg et Challonge, et ceux liés depuis Mido's House, Hyrule Town Hall et SpeedGaming, puis `sync-alttpr-asyncs.js` : séries async ALTTPR, puis `sync-alttpr-league.js --current` : saison en cours de l'ALTTPR League, puis `sync-gdq-runs.js` : runs randomizer des marathons GDQ (voir plus bas) |
| `players` | tous les jours à 7h30 | `sync-players-from-races.js` : un joueur par compte racetime.gg (source de vérité), au nom de sa dernière course ; `sync-racetime-profiles.js --stale-days 7 --limit 1200` relit le profil racetime des joueurs (chacun une fois par semaine) : nom actuel, compte supprimé ; puis `link-participant-accounts.js --all --apply` relie chaque participant de tournoi au compte racetime qui a couru ses matchs (voir plus bas) |
| `challonge-check` | tous les jours à 7h45 | `check-challonge-quota.js` : une seule requête Challonge, en erreur sur la page de santé tant que le quota (500 requêtes sur 30 jours glissants) est épuisé ; à son retour, les imports Challonge en attente se lancent à la main |
| `backup` | tous les jours à 3h30 | `backup-db.js` : archive `mongodump` de la base, 7 gardées |

Chaque tâche se lance aussi à la main : `scripts/cron/run-job.sh <tâche>`.

L'API Challonge n'autorise que 500 requêtes par 30 jours (au-delà : erreur 429 jusqu'à la fin de la fenêtre). Un bracket coûte une seule requête (`getTournamentDetails`, participants et matchs inclus). `tournaments-update` ne relit un tournoi Challonge qu'une fois par 24 h (`--challonge-hours`), une fois par semaine s'il attend la validation de l'organisateur (`awaiting_review`), et n'appelle plus Challonge dès le premier 429. La découverte speedgaming.org n'interroge pas l'API pour un lien déjà en base, dont le titre n'évoque pas un randomizer, ou écarté depuis moins de 30 jours (`discoveryskips`).

À chaque exécution, `run-job.sh` écrit l'état de la tâche dans `~/logs/status/<tâche>.json` (début, fin, code de sortie, dernier succès, échecs de suite). La page **Monitoring** du panneau admin les lit (`services/job-health.js`), affiche l'horaire de chaque tâche (tiré de son expression cron), la durée de sa dernière exécution et l'heure de la prochaine, et la classe : ok, en cours, en échec (avec la fin de son journal), en retard (pas de succès depuis plus de deux périodes) ou jamais lancée. Elle montre aussi la dernière donnée écrite en base par la tâche (dernière course, dernière recherche de VOD, dernière archive…), qui trahit une tâche « réussie » sans rien faire. Le serveur et la crontab doivent partager le même `LOG_DIR` (`~/logs` par défaut). Pour resynchroniser entièrement un jeu : `node scripts/sync-racetime-game.js --game <slug> [--max-pages N]`.

### Anciens workflows GitHub Actions

Les workflows de `.github/workflows/` faisaient le même travail depuis les serveurs de GitHub, à une époque où la base était hébergée sur MongoDB Atlas. Ils ne peuvent pas joindre une base fermée au réseau : ils sont désactivés depuis l'onglet **Actions** au passage sur le serveur, et gardés dans le dépôt le temps de la transition. Ils utilisent les secrets `MONGODB_URI`, `STARTGG_API_TOKEN` et `CHALLONGE_API_KEY` et la variable facultative `RACETIME_RATE_LIMIT_MS`.

## Détection des tournois

`discover-tournaments.js` retient un tournoi s'il correspond à :

1. des mots-clés génériques : `randomizer`, `randomiser`, `rando`, `multiworld`, `archipelago`…
2. les noms des jeux présents en base (nom, acronymes) ;
3. le jeu déclaré sur start.gg ou Challonge.

`discover-tournaments.js --source speedgaming` lit la page [speedgaming.org/events](https://speedgaming.org/events/), qui n'a pas d'API, et y prend les liens « Bracket/standings » de chaque événement. Un bracket start.gg passe par l'import start.gg ; un bracket Challonge coûte une requête, aussi n'est-il lu que si le titre de l'événement évoque un randomizer. Un lien écarté (pas un randomizer suivi, bracket privé ou supprimé) est noté dans `discoveryskips`. La source fait partie de la découverte quotidienne.

`helpers/find-game-for-tournament.js` associe ensuite le tournoi à un jeu du site. Les tournois déjà présents en base ne sont pas réimportés.

Les courses sont rattachées aux matchs par `services/tournament-autolink.js` (score de confiance) et aux qualifications par `services/tournament-qualifiers.js`. Le panneau admin permet de vérifier ou de corriger ces liens. Sa liste des tournois (« Race ↔ Match ») donne pour chacun la part des matchs joués qui ont leurs courses (`services/link-coverage.js` : matchs terminés entre deux joueurs, forfaits « DQ » exclus) et les courses rattachées au tournoi sans match, qualification ni tie-break. Le filtre « À reprendre » et le tri « Plus de rattachements manquants » mènent aux tournois à compléter ; un tournoi sans aucune course (jeu qui ne se court pas sur racetime.gg, comme Melee) est classé « sans course » et sort du total.

### Horaires Mido's House et Hyrule Town Hall

[Hyrule Town Hall](https://hyruletownhall.com) fait tourner le code de Mido's House pour d'autres jeux Zelda (ALTTPR, TWWR, MMR, mais aussi des tournois speedrun BotW et TP) : mêmes pages, même API. Tout ce qui suit vaut pour les deux sites ; `midosHouse.site` dit d'où viennent les données d'un tournoi (`midos` ou `hth`, absent : Mido's House). `sync-schedule-sites.js` lit les deux sites, ou un seul avec `--site midos|hth`.

Les joueurs des tournois OoTR fixent l'horaire de leurs races sur [Mido's House](https://midos.house) (commande `/schedule` du bot Discord, dans le serveur du tournoi) et les restreamers y ajoutent leur chaîne, par langue. Son API GraphQL ne donne ni les liens de restream ni les sets start.gg : `services/schedule-sites.js` lit donc la page `/event/<série>/<édition>/races` de chaque événement listé sur l'accueil, et y prend l'heure de départ, le lien du set start.gg et les liens « <Langue> restream ».

`sync-schedule-sites.js` range ces races sur le tournoi start.gg correspondant (trouvé par son `startggSlug`), dans un champ à part de `matches`, que la synchronisation start.gg reconstruit à chaque passage :

- `midosHouse.schedule` : les races à venir, remplacées à chaque exécution. Une race jouée en sort, et un événement qui quitte l'accueil de son site voit sa liste vidée.
- `midosHouse.pastRestreams` : les races jouées qui ont eu un restream, gardées une fois l'événement terminé.

Une race encore listée « à venir » 12 h après son heure compte comme jouée : la page d'un événement terminé n'a qu'un seul tableau, sans titre « Past races ».

Chaque ligne donne aussi la room racetime.gg de la race et son set start.gg : la course est rattachée directement à ce match (confiance 900), sans passer par les noms et les horaires de l'auto-link. Une course que l'auto-link avait mise sur un autre match du tournoi est déplacée ; un lien fait à la main (999) ne bouge pas. Une room en trop pour un set déjà complet (room relancée…) est laissée de côté.

Le filtre des titres Twitch par série (« tournoi fr », « rsl »…, `helpers/restream-titles.js`) ne vaut que pour Mido's House : sur Hyrule Town Hall, « SpeedGaming » dans un titre ne désigne pas un autre tournoi.

Le script cherche ensuite la VOD de chaque restream joué, de trois façons :

1. **Lien de Mido's House** : pour les anciens événements, Mido's House donne souvent la vidéo elle-même (`twitch.tv/videos/…`, YouTube) au lieu de la chaîne. Elle devient la VOD, et la chaîne de la vidéo Twitch, demandée à Twitch, garde la trace de qui a restreamé. Le lien d'origine reste dans `sourceUrl`.
2. **Rediffusion Twitch** (`services/twitch-vods.js`, avec `TWITCH_CLIENT_ID` et `TWITCH_CLIENT_SECRET`) : pour les restreams joués depuis moins de 60 jours, la diffusion en cours à l'heure de départ de la race racetime.gg (ou à l'heure prévue si la race n'est pas en base). Le lien pointe sur ce moment de la vidéo.
3. **Temps forts et vidéos mises en ligne** : Twitch les garde sans limite de durée. Une vidéo de la chaîne convient si son titre contient le nom des deux joueurs (pseudo Mido's House ou start.gg), si elle a été créée après la race, et si le titre ne nomme ni un autre tournoi ni une autre saison. Pour une série en plusieurs races, le numéro de manche (`game`, calculé dans l'ordre des races du set) doit correspondre au « Game N » du titre. En routine, seules les races des 60 derniers jours sont cherchées ; `--archive` les cherche toutes.

Twitch efface les rediffusions au bout de 7 à 60 jours selon la chaîne (ou plus tôt, si le streamer les supprime). À chaque exécution, le script vérifie que les VOD Twitch trouvées sont encore en ligne : une VOD disparue perd son lien (`vodUrl`) et reçoit `vodGoneAt`, mais le restream garde sa chaîne et sa langue, et la page renvoie alors vers la chaîne.

`GET /api/tournaments/:id/matches` ajoute `scheduledAt` et `restreams` (avec `vodUrl`) à chaque match. L'onglet Restream de la page d'un tournoi liste les races à venir et jouées qui ont un restream, filtrables par langue. L'onglet Calendrier place mois par mois, à l'heure du visiteur, toutes les races du tournoi : jouées (départ de la room racetime.gg) et planifiées (`midosHouse.schedule`), chacune menant à son match.

Pour reprendre les événements terminés (une seule fois) : `node scripts/sync-schedule-sites.js --archive` (les deux sites, ou `--site hth --archive`).

`discover-tournaments.js --source hth` importe les tournois start.gg liés depuis les événements de Hyrule Town Hall. Le jeu vient de la page `/games/<slug>` de l'événement : ses slugs sont des catégories racetime.gg, et seul un slug qui est la catégorie d'un de nos jeux (`integrations.racetime.gameSlug(s)` : `alttpr`, `twwr`, `mmr`) mène à un import. Les tournois speedrun (`botw`, `tp`, dont les randomizers sont `botwr` et `tpr`) sont ignorés. La source fait partie de la découverte quotidienne.

Un événement sans sets start.gg (Challonge, bracket géré sur Mido's House) est rattaché au tournoi auquel sont liées ses races racetime.gg, si au moins 5 d'entre elles (et un tiers de ses rooms) y mènent : c'est le cas des Standard S6 et S7 et des RSL S2 et S3. Les restreams y sont reliés aux matchs par leur room racetime.gg. Les autres événements (Tournoi Francophone, Scrubs, SpeedGaming…) n'ont pas de tournoi en base et sont ignorés. La league a son propre script (ci-dessous).

### OoTR League

L'[OoTR League](https://league.ootrandomizer.com) fait s'affronter en 1 contre 1 les joueurs d'une même division ; son site, derrière une connexion Discord, n'est pas lisible. `sync-midos-league.js` crée donc un tournoi par saison (`source.type: 'midos-house'`, `source.externalId: 'league/<saison>'`), avec une phase round robin et un groupe par division, à partir des races racetime.gg :

- les rooms que l'API GraphQL de Mido's House donne pour la saison (série `league`), avec leur division (`round: "Div 7B"`) ;
- les races de l'objectif de la saison (« League Season 10 ») dont l'info commence par « Div 7D: A vs B » : la League ouvre aussi des rooms que Mido's House ne liste pas. Les races d'entraînement du même objectif (plusieurs joueurs, sans division) sont écartées.

Seules les races à deux joueurs, non annulées, comptent ; le vainqueur est celui qui finit premier. Une race déjà rattachée à un autre tournoi y reste. Les races retenues reçoivent le `tournamentId` de la saison. La page du tournoi montre victoires et défaites par division, pas les points officiels de la League. Mido's House ne connaît la League qu'à partir de la saison 4.

En routine, `--current` reprend la dernière saison en base et la suivante, dès que Mido's House la connaît. Sans option, le script reprend toutes les saisons.

### VOD Speedrace

[Speedrace](https://speedrace.deeplydevs.com) gère les restreams de quelques tournois OoTR, surtout francophones (Tournoi Francophone, Rupees of Time, Mixed Pools) : les organisateurs y créent les matchs, les restreamers s'y voient attribuer un match et y saisissent le lien de leur VOD. Les races restent planifiées sur Mido's House, où Speedrace renvoie le restreamer. Son API publique (`https://speedrace-api.deeplydevs.com/api/Planning/<jeu>/<tournoi>/<saison>?scope=All`, lue par `services/speedrace.js`) donne les matchs de chaque saison avec leurs restreams.

`sync-speedrace.js` lit la saison active de chaque tournoi (toutes avec `--all-seasons`) et retrouve chaque restream dans `midosHouse.pastRestreams` : la race restreamée sur la même chaîne Twitch à la même heure (à 1 h près), quel que soit le tournoi qui la porte. C'est ce qui rattache une saison Speedrace à son tournoi, sans table de correspondance. La VOD Speedrace est ajoutée au restream qui n'en a pas encore, si Twitch l'a toujours ; une VOD déjà trouvée par `sync-schedule-sites.js` est gardée (elle pointe sur le départ de la race). Un restream dont la race n'est pas en base (Tournoi Francophone, phases hors start.gg) est ignoré.

### Restreams localhorst

[alttp.localhorst.tv](https://alttp.localhorst.tv) planifie des races ALTTPR, Super Metroid Rando et SMZ3 avec leurs chaînes de restream (beaucoup de chaînes allemandes). Son API JSON est publique (`services/localhorst.js`) : `/api/events`, puis `/api/episodes?event[]=<id>&after=<date>`, 100 races à la fois ; elle refuse plus d'une requête par seconde environ (429).

Beaucoup de ses événements recopient un autre planning : SpeedGaming (`external_schedule` « sg:… »), que le site ne lit pas par ailleurs, ou Hyrule Town Hall (« hth:… », races dont l'`ext_id` commence par « hth: »). Ces derniers sont ignorés : `sync-schedule-sites.js` les lit à la source. Pour les autres, `sync-localhorst.js` range les chaînes de chaque race dans `race.restreams` de la course de sa room racetime.gg (langue de la chaîne), avec la rediffusion Twitch qui couvre le départ tant que Twitch la garde. Rien ne dépend de start.gg : la race n'a pas besoin d'être rattachée à un tournoi. Aucune donnée de joueur ni d'équipe n'est gardée.

Par défaut : événements en cours, races des 3 derniers jours (`--days N` pour remonter) ; `--archive` reprend tout une fois.

### Restreams des calendriers iCal

Certaines équipes de restream publient leur planning en calendrier public, un événement par match : « ALttPR Tournoi francophone 9e Édition: Ronde 2 - A vs B », la chaîne dans la description. C'est le cas des chaînes française et allemande de ZeldaSpeedRuns ([zsr.gg/schedule](https://zsr.gg/schedule), Google Calendar), qui restreament des tournois absents de Mido's House et de start.gg (Tournoi francophone et Micro-Tournoi ALTTPR, Deutsches Turnier, Rival Cup, Crosskeys…). `sync-ical-restreams.js` lit les flux de sa liste `FEEDS` (adresse `.ics`, chaîne et langue par défaut) avec `services/ical.js`, qui vaut pour tout calendrier iCal (Google Calendar, Horaro…). Le calendrier n'est pas toujours complet : les rediffusions Twitch de la chaîne du flux, dont les titres suivent le même format, sont lues de la même façon.

Aucun des deux ne donne la room racetime.gg. Un match est rattaché aux races :

- du jeu que nomme le titre avant les joueurs (`helpers/find-game-for-tournament.js`, puis les catégories racetime.gg du jeu) : un tournoi speedrun (BotW…) n'a pas de race rando et ne trouve rien ;
- parties entre 30 min avant et 3 h après l'heure prévue (pendant la rediffusion, pour une rediffusion Twitch) : toutes sont prises, un stream pouvant enchaîner plusieurs manches ;
- dont deux participants différents correspondent aux deux côtés de « A vs B » (`parseMatchup`, `sideNamesPlayer` de `helpers/restream-titles.js`) : un nom contient l'autre, sur au moins 4 caractères (« Tyrant » pour « Tyrant242 », « Mr. Navigator » pour « mr__navigator »).

Les matchs d'équipes (noms d'équipe), les courses hebdomadaires (sans « vs ») et les titres sans nom d'événement sont laissés de côté. La chaîne va dans `race.restreams`, avec la langue du flux et la rediffusion Twitch qui couvre le départ tant que Twitch la garde (ZeldaSpeedRuns met surtout ses VOD sur YouTube, que le site ne lit pas). Comme pour localhorst, la race n'a pas besoin d'être rattachée à un tournoi.

Par défaut : matchs des 3 derniers jours (`--days N` pour remonter) ; `--archive` reprend tous les événements des calendriers une fois ; `--feed <nom>` limite à un flux. Pour ajouter un calendrier, ajouter son adresse `.ics` à `FEEDS` et vérifier les rattachements avec `--dry-run --archive`, qui affiche chaque titre et la race trouvée.

### Asyncs ALTTPR

[ALttPR Asyncs](https://alttprasyncs.com) regroupe des seeds async en séries : entraînements d'un tournoi, qualifs live du Main (la room racetime.gg, puis des asyncs sur la même seed), ligues, séries hebdomadaires. Pas d'API : `services/alttpr-asyncs.js` lit les pages `/series`, `/series/<id>` et `/results/<id>`.

`sync-alttpr-asyncs.js` (tâche `tournaments-discover`) rattache chaque série au tournoi ALTTPR dont elle parle, par le nom : même genre de tournoi (main, crosskeys, co-op, spoiler, enemizer…) et même année, ou même numéro de saison ou d'édition. Une série ambiguë est signalée, pas rattachée ; `--link <série> <tournoi>` en rattache une à la main (gardée ensuite), `--unlink` la retire. Le résultat va dans `tournament.alttprAsyncs` :
- série d'entraînement : titre, lien et nombre de seeds, en bouton sur la page du tournoi ;
- série de qualifs (titre contenant « qualif ») : chaque seed avec sa room et ses résultats (arrivées live et asyncs ensemble, abandons, VOD), relus pendant 30 jours, affichés dans l'onglet Qualifications (masqués en mode anti-spoiler).

### ALTTPR League

L'[ALTTPR League](https://alttprleague.com) oppose des équipes de trois joueurs, une fois par semaine dans leur division, puis en playoffs ; chaque match d'équipes compte deux races (1 contre 1, co-op, ou « pilot » : un joueur de chaque équipe joue, l'autre guide). La ligue Open a son propre site, [open.alttprleague.com](https://open.alttprleague.com), avec le même logiciel. Pas d'API : `services/alttpr-league.js` lit la page de chaque équipe d'une saison (`/season_<n>/teams/<équipe>/`), qui contient un onglet par saison de l'équipe : ligue, division, effectif, puis chaque match (semaine ou tour de playoffs, adversaire, joueurs et temps de fin de chaque race).

`sync-alttpr-league.js` crée un tournoi par saison et par ligue (`source.type: 'alttpr-league'`, `source.externalId: '<invitational|open>/<saison>'`) : une phase « Saison régulière » (un groupe par division, le tour est la semaine) et une phase « Playoffs », un match par match d'équipes, au score des races gagnées, avec les joueurs de chaque équipe qui l'ont couru. Le site ne donne pas les rooms racetime.gg ; chaque race est retrouvée :

1. **par ses temps de fin**, que la League donne à la seconde, parmi les rooms ALTTPR de 2 à 4 participants dont l'objectif ou l'info parle d'une ligue : deux temps suffisent, un seul s'il s'accompagne des noms des joueurs. Certaines races n'ont que `finishTime` (« P0DT01H38M52S ») sans `finishTimeMs` : les deux sont lus ;
2. **par les noms des joueurs**, dans la semaine de la race (datée par les races trouvées par leurs temps ; une semaine sans aucune est placée entre ses voisines) : une room dont l'info nomme la League (« ALTTPR League S8 Invitational - A vs. B », abandons compris), ou toute room ALTTPR de la période dont les temps sont à moins d'une minute de ceux de la League (en 2020, les rooms SRL n'ont que le mode en objectif, et leurs temps diffèrent de quelques secondes des temps officiels).

Un nom de joueur correspond à un participant quand l'un contient l'autre (`sideNamesPlayer`) ; une room « pilot » n'a qu'un participant par équipe. Les races déjà rattachées à un autre tournoi y restent. Les participants du tournoi reçoivent le compte racetime.gg qui a couru leurs races. Environ 90 % des races sont retrouvées ; la saison 2 (2020, sur SRL) l'est aux deux tiers.

`--current` ne reprend que la dernière saison de chaque ligue ; `--site <invitational|open>` et `--season <n>` en choisissent une ; `--dry-run` affiche les races non retrouvées.

### Runs des marathons GDQ

Les marathons Games Done Quick (AGDQ, SGDQ, Frost et Flame Fatales…) accueillent régulièrement des runs et des races randomizer. L'API publique du tracker GDQ (`services/gdq.js`) donne chaque marathon, ses runs, leurs joueurs et leurs vidéos (VOD YouTube, ajoutées quelques semaines après le marathon). `sync-gdq-runs.js` garde les runs dont la catégorie ou le nom parle de randomizer (« Random Seed » des roguelikes ne compte pas) et les range dans `marathonruns`, rattachés au jeu du site :

- par la catégorie Twitch du run, quand elle est donnée, parmi celles des jeux (si plusieurs jeux la partagent : celui que le nom du run désigne, sinon celui dont le nom officiel est la catégorie, alttp plutôt que ses hacks) ;
- sinon par le nom du run, sans « Randomizer » ni « BONUS GAME n - » ;
- `GAME_HINTS` pour les noms qu'aucun des deux ne trouve (randomizer combo SMZ3).

Un run d'un jeu absent du site est signalé et laissé de côté. En routine, les marathons des 400 derniers jours sont relus (pour les VOD ajoutées après coup) ; `--all` les reprend tous. `GET /api/games/:id/marathon-runs` donne les runs d'un jeu ; l'onglet Streams de la page du jeu les liste sous les streams en direct (marathon, catégorie, joueurs, VOD) ; un joueur dont le nom ou un alias est celui d'un seul profil du site renvoie vers sa page, et la section reste masquée pour un jeu qui n'en a pas.

### VOD des joueurs

Les joueurs streament leurs races. `sync-race-vods.js` prend les races racetime.gg terminées, lit sur racetime.gg la chaîne Twitch de chaque joueur (`/data` de la race) et cherche la rediffusion en cours au départ de la race, avec un lien sur ce moment de la vidéo. Le résultat est rangé dans `race.vods` (`userId`, `userName`, `twitchName`, `vodUrl`), à part de `entrants`, que la synchronisation racetime.gg réécrit. Une race est cherchée jusqu'à 12 h après sa fin (`vodSearchedAt`), puis laissée de côté. Il faut un appel racetime.gg par race et un appel Twitch par joueur (les rediffusions d'une chaîne servent pour toutes ses races de l'exécution) ; en cas de limite de débit Twitch, le script attend puis réessaie.

À chaque exécution, les VOD trouvées sont vérifiées : une VOD que Twitch a supprimée perd son lien et reçoit `vodGoneAt`, la chaîne reste. La page d'une race affiche un bouton VOD à côté de chaque joueur, et les cartes de match de la page d'un tournoi un bouton par joueur à côté du lien racetime.gg.

### Restreams trouvés sur Twitch

Mido's House ne connaît que les restreams qu'il planifie : une race montée à la main (tie-break…) n'y figure pas. `sync-race-restreams.js` les cherche sur Twitch pour les races rattachées à un tournoi, sur les chaînes qui restreament ce tournoi d'après Mido's House, sur les chaînes communautaires de `COMMUNITY_RESTREAMERS` (Randomizer Brasil, qui restreame en portugais des tournois où Mido's House ne la liste pas ; langue lue sur Twitch) et sur celle de la personne qui a ouvert la room racetime.gg (les chaînes des joueurs exceptées). Un stream compte quand son titre nomme les joueurs (nom racetime.gg ou chaîne Twitch : les deux d'un 1v1, la moitié d'une room plus grande), ne parle pas d'entraînement et ne désigne pas un autre événement (mêmes mots-clés de série que pour les temps forts Mido's House) :
- race en cours : la chaîne en live, sur la page de la race ;
- race terminée : la rediffusion qui couvre le départ, liée à ce moment, cherchée jusqu'à 12 h après la fin (`restreamSearchedAt`) ; `--recheck` repasse les races déjà cherchées, après l'ajout d'une chaîne ;
- `--highlights` (rattrapage) : les temps forts et uploads, quand le titre ne correspond qu'à une seule race du tournoi dans les 14 jours précédents.

Le résultat va dans `race.restreams` (`language`, `url` de la chaîne, `vodUrl`, `title`), fusionné à l'affichage avec les restreams de Mido's House (un par chaîne). Les VOD supprimées par Twitch perdent leur lien, comme pour les joueurs.

## Modèle de données

Les schémas sont dans [`models/index.js`](../models/index.js).

| Collection | Contenu |
|------------|---------|
| `games` | Un jeu randomizer, ses ressources et ses intégrations externes |
| `races` | Une course (racetime.gg ou SpeedRunsLive, URL `/srl/<id>`) |
| `tournaments` | Un tournoi start.gg ou Challonge, ses phases, ses participants et, pour OoTR, ses races planifiées sur Mido's House |
| `matches` | Un match de tournoi et les courses qui y sont liées |
| `players` | Un joueur = un compte racetime.gg (`userId`), avec ses alias (pseudos utilisés ailleurs) |
| `marathonruns` | Un run randomizer d'un marathon (GDQ) : marathon, jeu, catégorie, joueurs, vidéos |
| `discoveryskips` | Liens Challonge écartés par la découverte speedgaming.org (pas un randomizer, bracket privé…), revus après 30 jours |
| `rando_list_cache` | Copie brute de rando-list et métadonnées de la dernière synchronisation |

### Joueurs et participants

racetime.gg est la source de vérité : un joueur est un compte racetime (`userId`), affiché sous son nom racetime actuel (celui de son profil, ou de sa dernière course si elle est plus récente que la dernière lecture du profil), quels que soient les pseudos de ses anciennes courses. Un compte que racetime ne connaît plus est marqué supprimé (`racetimeDeletedAt`) : il quitte la liste des joueurs et la recherche, ses courses restent ; il revient s'il répond de nouveau. Les joueurs SpeedRunsLive, sans compte, sont reconnus à leur nom. Les noms de tournoi ne créent pas de joueur.

Chaque participant de tournoi garde le compte racetime qui a couru ses matchs (`racetimeUserId`, `racetimeName`, [`helpers/participant-accounts.js`](../helpers/participant-accounts.js)), trouvé dans cet ordre :

1. les races 1v1 liées à ses matchs, y compris sous le nom start.gg « Préfixe | Gamertag » des sets ;
2. pour une équipe, les comptes qui l'ont courue contre plusieurs adversaires, appariés aux noms des membres ;
3. le compte qu'a eu le même nom, ou le même compte start.gg, dans un autre tournoi (si ce nom n'a jamais eu qu'un compte) ;
4. le compte racetime de ce nom exact dans les catégories du jeu du tournoi ;
5. le seul compte des races du tournoi encore libre qui ressemble au nom.

La page d'un ancien pseudo ou d'un nom de bracket qui mène à un seul compte redirige vers la page du compte.

### Jeux (`games`)

```
id                 identifiant interne, unique et immuable (ex. "alttp")
name               nom court du jeu
official           { name, releaseDate, releaseYear, website }   — le jeu d'origine
randomizer         { displayName, shortName, tinyName, name, website, opensource, addedDate, updatedDate }
resources          { officialSite, sites[], trackers[], guides[], other[] }
platforms[], series, logo, image, categories[]
integrations       { randoList, racetime, speedrun, twitch, startgg, challonge, archipelago, multiworld, apworld }
source             { origin: seed | csv-import | rando-list | manual | archipelago | apworld, importedAt }
enabled
```

Deux règles protègent les données saisies à la main :

- **L'`id` interne fait foi.** Les identifiants externes (slug racetime, id speedrun.com…) sont rangés dans `integrations.*` et ne le remplacent jamais.
- **`confidence: 'manual'` n'est jamais écrasé.** Chaque intégration porte un champ `confidence` : `auto` (trouvé par un script, peut être mis à jour) ou `manual` (fixé par un admin, laissé tel quel par les scripts).

**Lien avec rando-list.** `sync-rando-list.js` retrouve les randomizers d'un jeu par ses noms : `name`, `official.name`, `randomizer.name`, `randomizer.shortName` et surtout `integrations.randoList.gameName` et `gameNames`, les noms exacts de rando-list. Chaque nom de rando-list trouvé y est enregistré, pour que le lien survive à un changement de nom ou d'id. Le préfixe de génération de `Pokémon.yml` (« (III) Pokémon Emerald ») est ignoré.

**Lien avec Archipelago et Multiworld.** `sync-archipelago-games.js` lit la page `/games` des deux sites (`services/archipelago.js`) et rattache chaque monde à un jeu : d'abord par `integrations.archipelago.gameName` / `integrations.multiworld.gameName` (enregistré à chaque synchronisation ; avec `confidence: 'manual'`, fixé à la main), puis par la table `OVERRIDES` du script, le monde archipelago.gg du même nom, les liens archipelago.gg / multiworld.gg que le jeu a déjà (rando-list) et enfin ses noms (sans accents, « and »/« & », chiffres romains, parenthèses, sous-titre). Un monde sans jeu devient un jeu (`source.origin: archipelago`, id fait des initiales de son nom) ; un nom qui désigne plusieurs jeux est signalé et laissé de côté. Les liens ajoutés portent `source: 'archipelago'` : la synchronisation les remplace à chaque passage, et `sync-rando-list.js` les conserve. Quand un jeu a sa page sur un de ces sites, l'API masque le lien générique de rando-list vers ce site.

**APWorlds communautaires.** Un lien marqué Archipelago ou Multiworld qui n'est pas sur archipelago.gg / multiworld.gg (dépôt GitHub d'un monde distribué à part) s'affiche comme « APWorld communautaire (non officiel) », après les pages des deux sites, avec un ⚠️ quand le tableur le dit cassé (« Broken on Main »).

`sync-community-apworlds.js` lit le tableur communautaire des APWorlds (`services/community-apworlds.js`, export xlsx, le seul qui garde les liens) et rattache chaque ligne à un jeu : par `integrations.apworld.gameNames`, puis la table `OVERRIDES` du script, puis les noms du jeu **à l'identique** (noms du site, rando-list, Twitch, mondes archipelago.gg / multiworld.gg). Une ligne qu'une forme approchée seulement rattache (sous-titre, sans parenthèses…) n'est ni liée ni créée : elle est signalée « à vérifier » et se règle dans `OVERRIDES`. Une ligne sans aucun jeu proche devient un jeu (`source.origin: apworld`). Chaque jeu reçoit, en `source: 'apworld'` : l'APWorld (téléchargement, à défaut guide ou Discord) avec sa stabilité (`apworldStatus`), le tracker, le guide d'installation et, dans l'onglet Discord, l'invitation au serveur du fil de support (Archipelago, ou AP After Dark pour les jeux 18+ : un fil ne s'ouvre qu'aux membres) ; `integrations.apworld.mature` garde la mention 18+ / non classé du tableur. La ligne du monde core (« Core ») ou du monde de la page archipelago.gg / multiworld.gg du jeu ne donne pas d'APWorld, cette page en tient lieu ; une variante (« Ship of Harkinian », « Fabric »…) garde le sien. Pour les APWorlds venus d'ailleurs (rando-list, ajout à la main), l'API les masque, sans les supprimer, dès que le jeu a sa page sur un des deux sites.

**Fusion de jeux.** Un même jeu peut figurer plusieurs fois dans rando-list (une entrée par plateforme ou par édition) ; sur le site, il n'en fait qu'un. La fusion (panneau admin, ou `node scripts/merge-games.js <cible> <source>... [--rename <id>] [--short-name "<libellé>"]`, code dans `services/game-merge.js`) garde le jeu cible et supprime les sources : leurs ressources s'ajoutent sans doublon d'URL, ce qui manque à la cible (logo, plateformes, intégrations, catégories) est repris, leurs catégories racetime.gg deviennent des catégories supplémentaires de la cible (les courses ne sont pas modifiées) et leurs noms rando-list passent dans `gameNames`. La synchronisation suivante retrouve donc les sites de toutes les versions et ne les signale plus comme nouveaux jeux.

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
| `sync-archipelago-games.js` | `sync:archipelago` (+ `:dry`) | Jeux d'archipelago.gg et multiworld.gg : liens, nouveaux jeux (tâche `archipelago` ; `--no-create`, `--site`, `--verbose`) |
| `sync-community-apworlds.js` | `sync:apworlds` (+ `:dry`) | APWorlds du tableur communautaire : liens, stabilité, nouveaux jeux (tâche `archipelago`, après la précédente ; `--no-create`, `--verbose`) |
| `discover-tournaments.js` | `discover:tournaments` (+ `:dry`, `:startgg`, `:challonge`) | Découverte de tournois |
| `sync-tournaments.js` | `sync:tournaments` (+ `:dry`, `:update`) | Mise à jour des tournois actifs |
| `auto-link-tournaments.js` | `link:tournaments:active` | Rattache les courses aux matchs, et les tie-breaks à leur poule (`--all --tiebreaks-only` pour le rattrapage des anciens tournois) |
| `sync-players-from-races.js` | `sync:players` (+ `:dry`) | Recalcule la collection des joueurs |
| `sync-racetime-profiles.js` | | Nom racetime actuel et comptes supprimés (404, ou profil anonymisé « --Deleted Account-- »), depuis le profil de chaque joueur (`--dry-run`, `--limit N`, `--stale-days N`, `--user ID`) |
| `sync-race-vods.js` | `sync:race-vods` (+ `:dry`) | VOD Twitch des joueurs de chaque race (tâche `race-vods`) |
| `sync-schedule-sites.js` | `sync:schedule-sites` (+ `:dry`) | Horaires, restreams et VOD Mido's House et Hyrule Town Hall (tâche `schedule-sites`) |
| `sync-midos-league.js` | `sync:midos-league` (+ `:dry`) | Saisons de l'OoTR League en tournois (tâche `schedule-sites`, avec `--current`) |
| `sync-speedrace.js` | `sync:speedrace` (+ `:dry`) | VOD Speedrace des restreams Mido's House (tâche `schedule-sites`) |
| `sync-localhorst.js` | `sync:localhorst` (+ `:dry`) | Restreams planifiés sur alttp.localhorst.tv (tâche `schedule-sites`) |
| `sync-ical-restreams.js` | `sync:ical-restreams` (+ `:dry`) | Restreams des calendriers iCal des chaînes de restream (tâche `schedule-sites`) |
| `sync-alttpr-asyncs.js` | `sync:alttpr-asyncs` (+ `:dry`) | Séries async ALTTPR et résultats des qualifs (tâche `tournaments-discover`) |
| `sync-alttpr-league.js` | `sync:alttpr-league` (+ `:dry`) | Saisons de l'ALTTPR League (Invitational et Open) en tournois (tâche `tournaments-discover`, avec `--current`) |
| `sync-gdq-runs.js` | `sync:gdq-runs` (+ `:dry`) | Runs randomizer des marathons GDQ (tâche `tournaments-discover`) |

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
| `enrich-release-years.js` | — | Renseigne l'année de sortie des jeux depuis IGDB (via leur catégorie Twitch) |
| `fetch-covers.js` | — | Jaquettes manquantes (`public/assets/<id>.png`) : box art IGDB de la catégorie Twitch si elle porte le nom exact du jeu, sinon speedrun.com (nom exact) ; macOS (`sips`). `--no-speedrun` pour une passe rapide, speedrun.com limitant fort |
| `import-games-csv.js` | `import-games <fichier.csv>` | Import de jeux depuis un CSV (modèle : [`data/games-template.csv`](../data/games-template.csv)) |

### Maintenance

| Script | Commande npm | Rôle |
|--------|--------------|------|
| `unlink-race.js` | — | Détache une course de son match (aussi depuis l'admin) |
| `merge-games.js` | — | Fusionne plusieurs jeux en un (aussi depuis l'admin), avec renommage de l'id |
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
