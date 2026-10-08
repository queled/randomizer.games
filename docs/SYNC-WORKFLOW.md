# Chaîne de synchronisation

Comment les données arrivent sur le site, dans quel ordre, et comment relancer la chaîne à la main (par exemple pour rattraper une période où les tâches planifiées ne tournaient pas). Le détail de chaque script est dans [ARCHITECTURE.md](ARCHITECTURE.md#tâches-planifiées), la crontab dans [DEPLOYMENT.md](DEPLOYMENT.md#6-tâches-planifiées).

## Vue d'ensemble

```
 racetime.gg          start.gg / Challonge        midos.house            Twitch
      │                       │                        │                    │
      ▼                       ▼                        │                    │
 1. Courses ──────┐   2. Nouveaux tournois             │                    │
                  │           │                        │                    │
                  │           ▼                        │                    │
                  │   3. Tournois actifs (matchs)      │                    │
                  │           │                        │                    │
                  └─────────► 4. Auto-link courses ↔ matchs                 │
                              │                        │                    │
                              ▼                        ▼                    │
                         5. Horaires et restreams Mido's House ◄────────────┤
                              │                                             │
                              ▼                                             │
                         6. VOD des joueurs ◄───────────────────────────────┤
                              │                                             │
                              ▼                                             │
                         7. Restreams trouvés par titre Twitch ◄────────────┘
```

Chaque étape a besoin de ce que les précédentes ont écrit en base :

| # | Étape | Commande | A besoin de |
|---|-------|----------|-------------|
| 1 | Courses racetime.gg | `node scripts/sync-racetime-global.js` | — |
| 2 | Nouveaux tournois | `node scripts/discover-tournaments.js --since <date> --max-pages 3` | — |
| 3 | Tournois actifs | `node scripts/sync-tournaments.js --update-only` | les tournois en base (2) |
| 4 | Auto-link | `node scripts/auto-link-tournaments.js` | les courses (1) et les matchs à jour (3) |
| 5 | Mido's House | `node scripts/sync-midos-house.js` | les tournois start.gg (3) et les courses liées (4), pour l'heure de départ réelle et les événements sans sets start.gg |
| 6 | VOD des joueurs | `node scripts/sync-race-vods.js` | les courses terminées (1) |
| 7 | Restreams Twitch | `node scripts/sync-race-restreams.js` | les courses rattachées à un tournoi (4) et les chaînes de restream connues de Mido's House (5) |

Les étapes 1 et 2 sont indépendantes l'une de l'autre, et l'étape 6 ne dépend que de la 1. Lancer quand même le tout dans l'ordre du tableau : c'est le plus simple et rien n'est fait deux fois.

Hors chaîne, à lancer de temps en temps :

- `node scripts/sync-rando-list.js --detect-new` : cache rando-list et nouveaux jeux (tâche `rando-list`, quotidienne) ;
- `node scripts/sync-players-from-races.js` : collection des joueurs (tâche `players` de la crontab, avec `link-participant-accounts.js --all --apply`). Il **supprime** les joueurs « tournoi uniquement » : le passer d'abord avec `--dry-run`.

## En production

La crontab lance ces étapes via [`scripts/cron/run-job.sh`](../scripts/cron/run-job.sh), regroupées en tâches à des minutes décalées pour que l'ordre soit respecté la plupart du temps :

| Tâche | Étapes | Fréquence |
|-------|--------|-----------|
| `racetime` | 1 | toutes les 5 min |
| `tournaments-discover` | 2 (2 derniers jours) | tous les jours à 7h |
| `tournaments-update` | 3 puis 4 | toutes les 15 min (minute 2) |
| `midos-house` | 5 | toutes les 15 min (minute 7) |
| `race-vods` | 6 puis 7 | toutes les 30 min (minute 12) |

Si une tâche tombe avant que la précédente ait écrit ce qu'il lui faut, le passage suivant le rattrape : les étapes 6 et 7 cherchent une course jusqu'à 12 h après sa fin.

## Relancer à la main sur une période

Exemple : tout reprendre depuis le 7 octobre 2026. Depuis la racine du projet, avec le `.env` qui pointe sur la bonne base :

```bash
SINCE=2026-10-07
DAYS=2   # nombre de jours entre $SINCE et aujourd'hui, arrondi au-dessus

# 1. Courses : le mode normal, puis le rattrapage de toutes les catégories depuis $SINCE
node scripts/sync-racetime-global.js
node scripts/sync-racetime-global.js --catch-up-since $SINCE

# 2. Tournois créés depuis $SINCE (peut prendre plus de 10 min)
node scripts/discover-tournaments.js --since $SINCE --max-pages 3

# 3. et 4. Tournois actifs, puis rattachement des courses
node scripts/sync-tournaments.js --update-only
node scripts/auto-link-tournaments.js

# 5. Mido's House
node scripts/sync-midos-house.js

# 6. et 7. Twitch
node scripts/sync-race-vods.js --days $DAYS
node scripts/sync-race-restreams.js --days $DAYS
```

Points d'attention :

- **Racetime** : sans `--catch-up-since`, le script ne repasse qu'une tranche de catégories par exécution (un quart) ; pour une période, il faut le rattrapage.
- **Auto-link** : sans argument, il ne traite que les tournois actifs. Pour un tournoi terminé depuis : `node scripts/auto-link-tournaments.js <tournamentId>`.
- **Twitch** : par défaut les étapes 6 et 7 prennent les 2 derniers jours. Au-delà, passer `--days N` ; Twitch ne garde les rediffusions que 7 à 60 jours selon la chaîne. Pour des races plus anciennes, `sync-race-restreams.js --highlights` cherche dans les temps forts.
- Chaque script accepte `--dry-run` (sauf `sync-racetime-global.js`) pour vérifier avant d'écrire.

Sur le serveur, on peut aussi lancer les tâches de la crontab dans l'ordre, avec leurs verrous et leurs journaux (`~/logs/<tâche>.log`), mais sur leurs fenêtres par défaut :

```bash
for job in racetime tournaments-discover tournaments-update midos-house race-vods; do
  scripts/cron/run-job.sh "$job"
done
```
