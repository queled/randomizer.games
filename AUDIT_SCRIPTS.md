# 📊 Audit Scripts - Nettoyage pour Publication GitHub

**Date**: 31 mars 2026  
**Total scripts**: 63 + dossiers (archived/, debug/, tmp/)  
**Objectif**: Identifier ce qui doit rester pour la production publique

---

## ✅ **SCRIPTS À CONSERVER** (22 scripts)

### Synchronisation / Production (utilisés en cron + package.json)

1. **`sync-racetime-global.js`** ✓ ESSENTIEL
   - Sync races toutes les 5 min
   - Utilisé: `npm run sync:racetime` + workflow GitHub

2. **`sync-racetime-game.js`** ✓ UTILE
   - Sync complet d'un jeu spécifique
   - Utilisé: workflow `sync-racetime-game-full.yml`

3. **`detect-new-racetime-categories.js`** ✓ UTILE
   - Détection auto des nouvelles catégories racetime
   - Utilisé: workflow GitHub

4. **`sync-players-from-races.js`** ✓ UTILE
   - Extrait joueurs depuis les races
   - Utilisé: `npm run sync:players` + global sync

5. **`sync-tournaments.js`** ✓ ESSENTIEL
   - Sync tournois (update + découverte)
   - Utilisé: `npm run sync:tournaments`

6. **`auto-link-tournaments.js`** ✓ ESSENTIEL
   - Relie tournois aux jeux internes
   - Utilisé: `npm run link:tournaments:active` + workflow

7. **`discover-tournaments.js`** ✓ ESSENTIEL
   - Découverte new tournois start.gg + Challonge
   - Utilisé: `npm run discover:tournaments` + workflow

8. **`check-rando-list-changes.js`** ✓ UTILE
   - Détecte nouveaux jeux dans rando-list
   - Utilisé: workflow `sync-rando-list.yml`

9. **`sync-rando-list-v3.js`** ✓ ESSENTIEL
   - Sync jeux depuis repo rando-list officiel
   - Utilisé: `npm run sync-rando-list` + workflow

### Imports / Exports

10. **`import-games-csv.js`** ✓ UTILE
    - Import/update jeux depuis CSV
    - Utilisé: `npm run import-games`

11. **`import-startgg.js`** ✓ UTILE
    - Import tournoi start.gg par URL/ID
    - Utilisé: `npm run import:startgg`

12. **`import-challonge.js`** ✓ UTILE
    - Import tournoi Challonge par ID
    - Utilisé: `npm run import:challonge`

13. **`import-multiworld-manual.js`** ✓ UTILE
    - Import multiworld données manuelles
    - Utilisé: `npm run import:multiworld-manual`

14. **`link-startgg-races.js`** ✓ UTILE
    - Relie races start.gg aux races racetime
    - Utilisé: `npm run link:startgg-races`

15. **`link-challonge-races.js`** ✓ UTILE
    - Relie races Challonge aux races racetime
    - Utilisé: `npm run link:challonge-races`

### Utilities de Données

16. **`enrich-games.js`** ✓ UTILE
    - Enrichit données jeux (images, URLs, etc.)
    - Utilisé: `npm run enrich-games`

17. **`normalize-race-urls.js`** ✓ MOYEN
    - Normalise URLs races après import
    - Utilisé: `npm run normalize:race-urls`

18. **`cleanup-race-duplicates.js`** ✓ MOYEN
    - Nettoie doublons races
    - Utilisé: `npm run cleanup:race-duplicates`

### Setup / Maintenance

19. **`setup-db.js`** ✓ UTILE
    - Initialise base de données + seed
    - Utilisé: `npm run db:setup`

20. **`backup-db.js`** ✓ UTILE
    - Sauvegarde base de données
    - Utilisé: `npm run db:backup`

21. **`setup-alttp-community-resources.js`** ✓ MOYEN
    - Configure ressources communautaires ALTTP
    - Utilisé: `npm run setup:alttp-resources`

22. **`check-security.js`** ✓ CRITIQUE
    - Vérification pré-déploiement
    - Utilisé: `npm run check-security` (predeploy)

---

## 🟡 **SCRIPTS SUSPECTS / À CLARIFIER** (12 scripts)

### Variantes anciennes (À SUPPRIMER)

1. **`sync-rando-list-v2.js`** ❌ ANCIEN
   - Remplacé par `sync-rando-list-v3.js`
   - Recommandation: **SUPPRIMER**

2. **`sync-racetime-all.js`** ❌ ANCIEN
   - Probablement remplacé par `sync-racetime-global.js`
   - Recommandation: **SUPPRIMER**

3. **`sync-racetime-incremental.js`** ❌ ANCIEN
   - Probablement remplacé par `sync-racetime-global.js`
   - Recommandation: **SUPPRIMER**

4. **`sync-racetime-finalize.js`** ❌ ANCIEN
   - Logique intégrée dans `sync-racetime-global.js`
   - Recommandation: **SUPPRIMER**

5. **`auto-link-races.js`** ❌ ANCIEN
   - Probablement remplacé par `auto-link-tournaments.js`
   - Recommandation: **SUPPRIMER**

6. **`auto-link-races-global.js`** ❌ ANCIEN
   - Lien global remplacé par `auto-link-tournaments.js`
   - Recommandation: **SUPPRIMER**

### Utilitaires à Clarifier

7. **`link-race-to-match.js`** ⚠️ UTILE?
   - Relie race spécifique à un match
   - Recommandation: **GARDER** (peut être utile après import manuel)

8. **`enrich-races.js`** ⚠️ REMPLACÉ?
   - Enrichit races individuelles
   - Recommandation: **VÉRIFIER** si utilisé ou remplacé par `enrich-games.js`

9. **`unlink-race.js`** ⚠️ UTILITY
   - Détache race d'un lien
   - Recommandation: **GARDER** (maintenance/corrections)

10. **`enrich-twitch.js`** ⚠️ INTÉGRITÉ DONNÉES
    - Ajoute données Twitch aux streams
    - Recommandation: **GARDER** (optionnel mais utile)

11. **`import-and-link-racetime.js`** ❌ ANCIEN
    - Combinaison de deux opérations
    - Recommandation: **VÉRIFIER + SUPPRIMER**

12. **`sync-players-from-races.js`** (DÉJÀ LISTÉ) - Gardé dans production

---

## 🔴 **SCRIPTS À SUPPRIMER** (29+ scripts)

### Corrections One-Off (Migration, Bug Fixes)

```
❌ add-alttpr-ladder-slug.js          - ALTTP ladder specific, one-time fix
❌ backfill-populate-source.js        - Migration historique
❌ backfill-race-info.js              - Backfill ancien
❌ fix-alttp-config.js                - One-time ALTTP correction
❌ fix-games-report.js                - One-time fix
❌ fix-import-origin.js               - One-time migration
❌ fix-race-info-multiline.js         - One-time data cleaning
❌ fix-single-race.js                 - Debug/one-time
❌ fix-stale-races.js                 - One-time cleanup
❌ fix-startgg-winner.js              - One-time correction
❌ link-ootr-s9-races.js              - Season 9 OOTR, one-time
❌ migrate-challonge-source.js        - Migration historique
❌ remove-tournament-from-races.js    - One-time fix
❌ update-alttp.js                    - One-time ALTTP update
❌ unlink-imported-racetime-races.js  - One-time cleanup
```

### Debug / Analysis Scripts

```
❌ analyze-player-mappings.js         - Debug analysis
❌ analyze-race-names.js              - Debug analysis
❌ analyze-tournament-full.js         - Debug analysis
❌ analyze-tournament.js              - Debug analysis
❌ check-race.js                      - Debug inspection
❌ check-racetime-profiles.js         - Debug check
❌ check-stuck-races.js               - Debug check
❌ debug-link.js                      - Debug linking
❌ detect-player-duplicates.js        - Debug detection
❌ export-startgg-autolink-candidates.js - Report export
❌ fill-missing-release-years.js      - Utils (peut être gardé)
❌ test-startgg-phases.js             - Test script
❌ test-startgg.js                    - Test script
❌ verify-aliases-db.js               - Debug verify
❌ verify-aliases.js                  - Debug verify
❌ verify-challonge-source.js         - Debug verify
```

---

## 📁 **DOSSIERS À SUPPRIMER**

### `/scripts/archived/` (4 scripts)
```
❌ check-xavi-icola-races.js          - Historic races, specific user
❌ debug-score-breakdown.js           - Score calculation debug
❌ show-association-scores.js         - Debug scores
❌ update-kh2-name.js                 - One-time KH2 fix
```

### `/scripts/debug/` (9 scripts)
```
❌ check-duplicate-races.js           - Debug duplicate detection
❌ check-tournament.js                - Debug tournament check
❌ debug-new-games-detection.js       - Debug game detection
❌ delete-duplicate-races.js          - Debug deletion
❌ inspect-races.js                   - Debug inspection
❌ list-tournament-matches.js         - Debug listing
❌ print-sample-docs.js               - Debug printing
❌ quick-dup-check.js                 - Quick debug check
❌ test-pagination.js                 - Debug pagination
```

### `/scripts/tmp/` (5 fichiers)
```
❌ duplicates-report.txt              - Report file
❌ find-duplicates.py                 - Python script (hors-scope)
❌ new-games-report.json              - Report file
❌ test-pageinfo.js                   - Test temp
✓  rando-list/                        - À vérifier si important
```

---

## 📋 **RÉSUMÉ DES ACTIONS**

| Catégorie | Nombre | Action |
|-----------|--------|--------|
| À garder | 22 | Rien |
| À clarifier | 2 | Vérifier utilisation |
| À supprimer (variantes) | 6 | **SUPPRIMER** |
| À supprimer (debug/test) | 18 | **SUPPRIMER** |
| À déplacer (archived/) | 4 | **SUPPRIMER** ou archiver |
| À déplacer (debug/) | 9 | **SUPPRIMER** ou archiver |
| À déplacer (tmp/) | 5 | **NETTOYER** |
| **TOTAL À NETTOYER** | **42+** | |

---

## ✨ **PLAN RECOMMANDÉ**

### Phase 1: Nettoyage rapide (aucune dépendance)
1. **Supprimer dossiers entiers**:
   - `/scripts/archived/` → **DELETE**
   - `/scripts/debug/` → **DELETE**
   - `/scripts/tmp/` → **DELETE**

2. **Supprimer variantes anciennes**:
   - `sync-rando-list-v2.js`
   - `sync-racetime-all.js`
   - `sync-racetime-incremental.js`
   - `sync-racetime-finalize.js`
   - `auto-link-races.js`
   - `auto-link-races-global.js`

3. **Supprimer corrections one-off**: (tous les `fix-*.js`, `add-*.js`, etc.)

### Phase 2: Vérification (avant suppression)
1. Vérifier que `enrich-races.js` n'est pas appelé ailleurs
2. Vérifier que `import-and-link-racetime.js` n'est pas documenté
3. Vérifier que `link-race-to-match.js` n'est pas API-essentiel

### Phase 3: Cleanup (après vérification)
1. Supprimer tous les debug/test scripts
2. Supprimer tous les reports/exports générés
3. Supprimer les variantes anciennes

---

## 🎯 **RÉSULTAT FINAL ATTENDU**

📦 **De 63 scripts → 24 scripts** (22 utiles + 2 à clarifier)

**Dossiers restants**:
```
scripts/
├── sync-racetime-global.js
├── sync-racetime-game.js
├── detect-new-racetime-categories.js
├── sync-players-from-races.js
├── sync-tournaments.js
├── auto-link-tournaments.js
├── discover-tournaments.js
├── check-rando-list-changes.js
├── sync-rando-list-v3.js
├── import-games-csv.js
├── import-startgg.js
├── import-challonge.js
├── import-multiworld-manual.js
├── link-startgg-races.js
├── link-challonge-races.js
├── link-race-to-match.js (A CLARIFIER)
├── enrich-games.js
├── enrich-races.js (A VÉRIFIER)
├── normalize-race-urls.js
├── cleanup-race-duplicates.js
├── setup-db.js
├── backup-db.js
├── setup-alttp-community-resources.js
├── check-security.js
├── unlink-race.js (A CLARIFIER)
├── enrich-twitch.js (OPTIONNEL)
├── migrations/
└── (Pas de archived/, debug/, tmp/)
```

---

## 📝 **Récommandations Additionnelles pour Public**

1. **Ajouter `.gitignore`** pour:
   - `*.log` (logs d'exécution)
   - `/tmp/**` (fichiers temporaires)
   - `/reports/**` (rapports générés)

2. **Documenter** dans `README.md`:
   - Liste des commandes npm disponibles
   - Workflows GitHub Actions expliqués

3. **Créer `docs/SCRIPTS.md`**:
   - Description de chaque script gardé
   - Exemples d'utilisation

4. **Vérifier `.env.example`**:
   - Todos les tokens/clés API documentés
   - Pas de secrets en dur

