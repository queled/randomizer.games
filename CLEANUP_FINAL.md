# 🧹 NETTOYAGE SCRIPTS ET MIGRATIONS - GUIDE FINAL

**Date**: 31 mars 2026  
**Statut**: ✅ Prêt à exécuter  
**Scope**: 40 scripts + 10 migrations à supprimer

---

## 📊 RÉSUMÉ EN CHIFFRES

| Catégorie | Avant | Après | À Supprimer |
|-----------|-------|-------|-------------|
| Scripts | 63 | 23 | -40 |
| Migrations | 11 | 1 | -10 |
| **TOTAL** | **74** | **24** | **-50** |

---

## 🚀 EXÉCUTION RAPIDE (5 minutes)

### 1️⃣ Sauvegarder
```bash
cd ~/Library/Mobile\ Documents/com~apple~CloudDocs/Projets/Website/Randomizer/V2
git add -A
git commit -m "Backup: avant cleanup scripts+migrations"
git tag backup-before-cleanup
```

### 2️⃣ Nettoyer (automatique)
```bash
chmod +x cleanup-scripts.sh
./cleanup-scripts.sh
```

### 3️⃣ Vérifier
```bash
npm run check-security         # ✅ Doit passer
npm start &
sleep 2 && curl http://localhost:3000 > /dev/null && kill %1
npm run sync:racetime -- --help  # Vérifier script existe
```

### 4️⃣ Publier
```bash
git add -A
git commit -m "🧹 Cleanup: 40 scripts + 10 migrations supprimés

Scripts:
  ❌ 40 scripts inutiles supprimés
  ✅ 23 scripts production conservés

Migrations:
  ❌ 10 migrations one-time supprimées
     • bulk-convert-finishTimes.js
     • import-player-marco.js (😄 Marco)
     • fix-race-urls.js
     • et 7 autres...
  ✅ 1 migration gardée: migrate-game-schema.js

Résultat: 74 → 24 fichiers (-68%)"

git push
```

---

## ✅ SCRIPTS À GARDER (23)

### Production Core (9)
```
✅ sync-racetime-global.js        (5min cron)
✅ sync-tournaments.js            (quotidien)
✅ sync-rando-list-v3.js          (quotidien)
✅ discover-tournaments.js        (auto-découverte)
✅ auto-link-tournaments.js       (lien jeux)
✅ check-rando-list-changes.js    (détection)
✅ sync-racetime-game.js          (full sync jeu)
✅ detect-new-racetime-categories (catégories)
✅ sync-players-from-races.js     (extraction)
```

### Imports (7)
```
✅ import-games-csv.js
✅ import-startgg.js
✅ import-challonge.js
✅ import-multiworld-manual.js
✅ link-startgg-races.js
✅ link-challonge-races.js
✅ normalize-race-urls.js
```

### Utilities (6)
```
✅ enrich-games.js
✅ enrich-races.js
✅ enrich-twitch.js
✅ cleanup-race-duplicates.js
✅ unlink-race.js
✅ link-race-to-match.js
```

### Admin (1)
```
✅ check-security.js
✅ setup-db.js
✅ backup-db.js
✅ setup-alttp-community-resources.js
```

---

## ❌ MIGRATIONS À SUPPRIMER (10)

### One-Time Conversions (4)
```
❌ bulk-convert-finishTimes.js
❌ convert-race-finishTime.js
❌ dry-run-convert-finishTimes.js
❌ fix-race-urls.js
```

### One-Time Imports/Updates (6)
```
❌ import-player-marco.js             (Marco 😄)
❌ cleanup-auto-created-games.js
❌ migrate-add-game-ref.js
❌ migrate-shortName-to-randomizer.js
❌ update-tournament-gamenames.js
❌ migrate-convert-times.js
```

### Migration à Garder (1)
```
✅ migrate-game-schema.js  (Production migration, utilisée en prod)
```

---

## 🔍 VU D'ENSEMBLE FINALISÉ

```
scripts/
├── [PRODUCTION - 23 files]
│   ├── sync-racetime-global.js ✅
│   ├── sync-tournaments.js ✅
│   ├── discover-tournaments.js ✅
│   ├── import-games-csv.js ✅
│   └── ... (19 autres ✅)
│
├── [GARDER] migrations/
│   ├── migrate-game-schema.js ✅
│   └── [9 migrations supprimées]
│
├── [SUPPRIMÉ] archived/               ❌
├── [SUPPRIMÉ] debug/                  ❌
├── [SUPPRIMÉ] tmp/                    ❌
└── [SUPPRIMÉ] 40 scripts individuels  ❌
```

---

## ⚠️ SI QUELQUE CHOSE CASSE

### Restaurer depuis backup
```bash
git checkout backup-before-cleanup
# Ou simplement
git revert HEAD
```

### Vérifier les diffs
```bash
git diff backup-before-cleanup HEAD -- scripts/ | head -100
```

---

## 📝 CHECKLIST AVANT GIT PUSH

- [ ] `./cleanup-scripts.sh` exécuté sans erreur
- [ ] `npm run check-security` passe ✅
- [ ] `npm start` démarre correctement
- [ ] Curler `http://localhost:3000` fonctionne
- [ ] `npm run sync:racetime -- --help` existe
- [ ] `npm run migrate:game-schema -- --dry-run` existe
- [ ] Aucun fichier supprimé par accident
- [ ] Git tags `backup-before-cleanup` créé

---

## 🎉 VOUS ÊTES PRÊT!

**TL;DR**:
```bash
chmod +x cleanup-scripts.sh && ./cleanup-scripts.sh
git add -A
git commit -m "🧹 Cleanup: 50 fichiers inutiles supprimés"
git push
```

**Repos avant**: 74 fichiers scripts/migrations (confus)  
**Repos après**: 24 fichiers (clair, production-ready) ✅

---

## 📚 RÉFÉRENCES

- [MIGRATIONS_ANALYSIS.md](MIGRATIONS_ANALYSIS.md) - Détails migrations
- [cleanup-scripts.sh](cleanup-scripts.sh) - Script automatisé
- [AUDIT_SCRIPTS.md](AUDIT_SCRIPTS.md) - Audit complet (si créé)
