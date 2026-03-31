# 📋 Audit Dossier `/scripts/migrations/` 

**Total fichiers**: 11 migrations  
**À garder**: 2-3  
**À supprimer**: 8-9  

---

## ✅ **À GARDER** (2-3 scripts)

### Migration Essentielles
1. **`migrate-game-schema.js`** ✓ UTILISÉ
   - Utilisé dans `package.json`: `npm run migrate:game-schema`
   - Migration critique: officialName → official.name
   - **Raison**: Peut être re-exécuté en production

2. **`migrate-convert-times.js`** ⚠️ POTENTIELLEMENT UTILE
   - Convertit finishTime vers finishTimeMs
   - Peut être nécessaire si données incomplètes
   - **Décision**: À clarifier OU supprimer

---

## ❌ **À SUPPRIMER** (8-9 scripts)

### One-Time Conversions (À nettoyer)
```
❌ bulk-convert-finishTimes.js         - Conversion historique
❌ convert-race-finishTime.js          - Variante de conversion
❌ dry-run-convert-finishTimes.js      - Dry-run de conversion (temporaire)
❌ fix-race-urls.js                    - One-time fix
```

### One-Time Imports/Updates (Données spécifiques)
```
❌ import-player-marco.js              - Import joueur MARCO spécifique (lol!)
❌ cleanup-auto-created-games.js       - One-time cleanup
❌ migrate-add-game-ref.js             - Migration historique
❌ migrate-shortName-to-randomizer.js  - Migration historique
❌ update-tournament-gamenames.js      - Update one-time
```

---

## 🎯 **RECOMMANDATION FINALE**

### Supprimer tous les fichiers SAUF:
```bash
✅ migrate-game-schema.js              # Production migration - GARDER
```

### Optionnel (à clarifier):
```bash
❓ migrate-convert-times.js            # Garder ou supprimer?
```

### Résultat:
```
Avant: 11 migrations
Après: 1 migration (+ optionnel 1)
```

---

## ⚡ **ACTION RAPIDE**

Ajouter À `cleanup-scripts.sh`:

```bash
# Supprimer migrations inutiles
echo "📁 Phase X: Migrations obsolètes"
rm -f scripts/migrations/bulk-convert-finishTimes.js
rm -f scripts/migrations/convert-race-finishTime.js
rm -f scripts/migrations/dry-run-convert-finishTimes.js
rm -f scripts/migrations/fix-race-urls.js
rm -f scripts/migrations/import-player-marco.js
rm -f scripts/migrations/cleanup-auto-created-games.js
rm -f scripts/migrations/migrate-add-game-ref.js
rm -f scripts/migrations/migrate-shortName-to-randomizer.js
rm -f scripts/migrations/update-tournament-gamenames.js
```

---

Veux-tu que j'update `cleanup-scripts.sh` pour inclure les migrations?
