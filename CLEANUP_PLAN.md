# 🚀 PLAN D'EXÉCUTION - Nettoyage Scripts pour Production

**Date**: 31 mars 2026  
**Statut**: Prêt à exécuter  
**Impact**: Réduction de 63 → ~24 scripts (re-branding pour public)

---

## ✅ **DÉCISIONS FINALES**

### Scripts à SUPPRIMER DÉFINITIVEMENT

#### 1. Dossiers entiers (18 scripts)
```bash
rm -rf scripts/archived/      # 4 scripts: Xavi races, score debug, etc.
rm -rf scripts/debug/         # 9 scripts: Inspection/verification tools anciens
rm -rf scripts/tmp/           # 1-2 fichiers temp + rando-list/
```

#### 2. Variantes anciennes (6 scripts)
```bash
rm -f scripts/sync-rando-list-v2.js           # v3 est le standard
rm -f scripts/sync-racetime-all.js            # Remplacé par sync-racetime-global.js
rm -f scripts/sync-racetime-incremental.js    # Ancien
rm -f scripts/sync-racetime-finalize.js       # Logique intégrée dans sync-racetime-global.js
rm -f scripts/auto-link-races.js              # Remplacé par auto-link-tournaments.js
rm -f scripts/auto-link-races-global.js       # Ancien
```

#### 3. One-off fixes & migrations (15 scripts)
```bash
# Corrections ALTTP spécifiques
rm -f scripts/add-alttpr-ladder-slug.js
rm -f scripts/fix-alttp-config.js
rm -f scripts/update-alttp.js

# Backfill/migrations historiques
rm -f scripts/backfill-populate-source.js
rm -f scripts/backfill-race-info.js
rm -f scripts/migrate-challonge-source.js

# Fix data one-time
rm -f scripts/fix-games-report.js
rm -f scripts/fix-import-origin.js
rm -f scripts/fix-race-info-multiline.js
rm -f scripts/fix-single-race.js
rm -f scripts/fix-stale-races.js
rm -f scripts/fix-startgg-winner.js

# Removals/unlinks one-time
rm -f scripts/link-ootr-s9-races.js
rm -f scripts/remove-tournament-from-races.js
rm -f scripts/unlink-imported-racetime-races.js
```

#### 4. Analysis/Debug/Test (16 scripts)
```bash
# Analysis scripts (no longer needed)
rm -f scripts/analyze-player-mappings.js
rm -f scripts/analyze-race-names.js
rm -f scripts/analyze-tournament-full.js
rm -f scripts/analyze-tournament.js

# Debug/verification scripts
rm -f scripts/check-race.js
rm -f scripts/check-racetime-profiles.js
rm -f scripts/check-stuck-races.js
rm -f scripts/debug-link.js
rm -f scripts/detect-player-duplicates.js
rm -f scripts/fill-missing-release-years.js
rm -f scripts/verify-aliases-db.js
rm -f scripts/verify-aliases.js
rm -f scripts/verify-challonge-source.js

# Test scripts
rm -f scripts/test-startgg-phases.js
rm -f scripts/test-startgg.js

# Export reports
rm -f scripts/export-startgg-autolink-candidates.js
```

### Scripts À GARDER DÉFINITIVEMENT (24 scripts)

#### Production/Cron Essentiels (9)
✅ `sync-racetime-global.js` - Core sync races  
✅ `sync-tournaments.js` - Update + découverte tournois  
✅ `auto-link-tournaments.js` - Relie tournois aux jeux  
✅ `discover-tournaments.js` - Découverte start.gg + Challonge  
✅ `sync-rando-list-v3.js` - Sync jeux depuis rando-list  
✅ `check-rando-list-changes.js` - Détecte changements  
✅ `sync-racetime-game.js` - Sync complet jeu spécifique  
✅ `detect-new-racetime-categories.js` - Auto detect catégories  
✅ `sync-players-from-races.js` - Extrait joueurs  

#### Imports/Exports (7)
✅ `import-games-csv.js` - Import/update jeux CSV  
✅ `import-startgg.js` - Import tournoi start.gg  
✅ `import-challonge.js` - Import tournoi Challonge  
✅ `import-multiworld-manual.js` - Import multiworld manuel  
✅ `link-startgg-races.js` - Relie races start.gg  
✅ `link-challonge-races.js` - Relie races Challonge  
✅ `normalize-race-urls.js` - Normalise URLs  

#### Utilities & Maintenance (6)
✅ `cleanup-race-duplicates.js` - Cleanu doublons  
✅ `enrich-games.js` - Enrichit jeux (images, URLs)  
✅ `enrich-races.js` - Enrichit races (entrants détails) - **À CLARIFIER**
✅ `enrich-twitch.js` - Enrichit données Twitch  
✅ `unlink-race.js` - Détach race (maintenance)  
✅ `link-race-to-match.js` - Lie race à match  

#### Setup/Admin (3)
✅ `setup-db.js` - Initialise DB  
✅ `backup-db.js` - Sauvegarde DB  
✅ `setup-alttp-community-resources.js` - Setup ALTTP  

#### Sécurité (1)
✅ `check-security.js` - Vérif pré-déploiement  

#### Dossiers
✅ `/scripts/migrations/` - Scripts migrations (garder)

---

## ⚠️ **CAS LIMITES - DÉCISION REQUISE**

### Scripts à clarifier avant suppression

**1. `enrich-races.js`** ❓
- **Fonction**: Enrichit races existantes avec données entrants racetime.gg
- **Redondance?**: Peut-être avec `enrich-games.js`
- **Utilité**: Correction de données après import
- **Décision**: 
  - ✅ GARDER si utilitaire de maintenance importante
  - ❌ SUPPRIMER si redondant avec `enrich-games.js`
- **Recommandation**: **✅ GARDER** (utilité maintenance)

**2. `import-and-link-racetime.js`** ❓
- **Fonction**: Importe race + la lie à un tournoi
- **Redondance?**: Combine `import-startgg.js` + `link-startgg-races.js`?
- **Utilité**: Raccourci pour opération combinée
- **Décision**:
  - ✅ GARDER si shortcut pratique
  - ❌ SUPPRIMER si trop vieux/non-utilisé
- **Recommandation**: **❌ SUPPRIMER** (probablement ancien/redondant)

---

## 📊 **RÉSUMÉ FINAL**

| Catégorie | Avant | Après | Action |
|-----------|-------|-------|--------|
| Scripts utiles | 22 | 23 | Garder |
| Variantes anciennes | 6 | 0 | Supprimer |
| One-off fixes | 15 | 0 | Supprimer |
| Debug/Test/Analysis | 16 | 0 | Supprimer |
| Dossiers temp | 3 | 0 | Supprimer |
| **TOTAL** | **63** | **23-24** | **-39 scripts** |

---

## 🛠️ **EXÉCUTION DU NETTOYAGE**

### Étape 1: Faire une sauvegarde
```bash
git add -A
git commit -m "Pre-cleanup: Sauvegarde avant nettoyage scripts"
git tag backup-scripts-before-cleanup
```

### Étape 2: Vérification rapide
```bash
# Vérifier qu'aucun script supprimé n'est importé ailleurs
grep -r "require.*scripts/" routes/ middleware/ server.js || echo "✅ OK: Pas d'imports directs"

# Vérifier package.json
npm run integrity-check 2>/dev/null || echo "Note: integrity-check peut ne pas exister"
```

### Étape 3: Exécuter le nettoyage
```bash
# Option A: Exécuter le script de nettoyage (à améliorer)
bash cleanup-scripts.sh

# Option B: Commandes manuelles
rm -rf scripts/archived scripts/debug scripts/tmp
rm -f scripts/sync-rando-list-v2.js scripts/sync-racetime-all.js
# ... etc (voir script complet)
```

### Étape 4: Vérifier l'intégrité
```bash
# Vérifier que les scripts utilisés sont toujours présents
npm start                    # Vérifier que le serveur démarre
npm run check-security       # Vérifier sécurité
npm run sync:racetime --dry  # Test sync racetime
npm run discover:tournaments --dry  # Test découverte
```

### Étape 5: Commit final
```bash
git add -A
git commit -m "🧹 Cleanup: Supprimer 39 scripts non-utilisés avant publication

- ❌ Supprimé dossiers archived/, debug/, tmp/
- ❌ Supprimé variantes anciennes (sync-rando-list-v2, etc.)
- ❌ Supprimé one-off fixes et migrations
- ❌ Supprimé debug/test/analysis scripts (16 fichiers)
- ✅ Conservé 23 scripts essentiels pour production
- 📊 Résultat: 63 → 24 scripts (-62%)"

git push
```

---

## 📝 **CLEANUP.sh - Script Complet**

Voir fichier séparé: [cleanup-scripts.sh](cleanup-scripts.sh)

**Pour exécuter**:
```bash
chmod +x cleanup-scripts.sh
./cleanup-scripts.sh
```

---

## ✨ **Résultat Attendu**

```
✅ Repo plus propre pour publication
✅ Dossiers scripts réduit (63 → 23 fichiers)
✅ Zéro scripts de debug/test public
✅ README clair sur les commandes npm disponibles
✅ Prêt pour publication sur GitHub public
```

---

## 🎯 **Suivant**

Après ce nettoyage:
1. ✅ Documenter les scripts restants dans `docs/SCRIPTS.md`
2. ✅ Créer `docs/AUTOMATION.md` (déjà existant)
3. ✅ Vérifier `.gitignore` pour `*.log`, `reports/`, `backups/`
4. ✅ Ajouter `CODE_OF_CONDUCT.md`
5. ✅ Ajouter `CONTRIBUTING.md` (déjà existant)

