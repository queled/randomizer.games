#!/bin/bash
# Script de nettoyage des scripts non utilisés
# À exécuter depuis la racine du projet
# Après vérification du rapport AUDIT_SCRIPTS.md

set -e

echo "🧹 Nettoyage des scripts pour publication GitHub..."
echo ""

# Phase 1: Supprimer dossiers entiers
echo "📁 Phase 1: Suppression dossiers (archived/, debug/, tmp/)"
rm -rf scripts/archived/
rm -rf scripts/debug/
rm -rf scripts/tmp/

# Phase 2: Supprimer variantes anciennes
echo "🔄 Phase 2: Suppression variantes anciennes"
rm -f scripts/sync-rando-list-v2.js
rm -f scripts/sync-racetime-all.js
rm -f scripts/sync-racetime-incremental.js
rm -f scripts/sync-racetime-finalize.js
rm -f scripts/auto-link-races.js
rm -f scripts/auto-link-races-global.js

# Phase 3: Supprimer corrections one-off
echo "🔧 Phase 3: Suppression corrections one-off"
rm -f scripts/add-alttpr-ladder-slug.js
rm -f scripts/backfill-populate-source.js
rm -f scripts/backfill-race-info.js
rm -f scripts/fix-alttp-config.js
rm -f scripts/fix-games-report.js
rm -f scripts/fix-import-origin.js
rm -f scripts/fix-race-info-multiline.js
rm -f scripts/fix-single-race.js
rm -f scripts/fix-stale-races.js
rm -f scripts/fix-startgg-winner.js
rm -f scripts/link-ootr-s9-races.js
rm -f scripts/migrate-challonge-source.js
rm -f scripts/remove-tournament-from-races.js
rm -f scripts/update-alttp.js
rm -f scripts/unlink-imported-racetime-races.js

# Phase 4: Supprimer debug/test/analysis scripts
echo "🐛 Phase 4: Suppression debug/analysis/test scripts"
rm -f scripts/analyze-player-mappings.js
rm -f scripts/analyze-race-names.js
rm -f scripts/analyze-tournament-full.js
rm -f scripts/analyze-tournament.js
rm -f scripts/check-race.js
rm -f scripts/check-racetime-profiles.js
rm -f scripts/check-stuck-races.js
rm -f scripts/debug-link.js
rm -f scripts/detect-player-duplicates.js
rm -f scripts/export-startgg-autolink-candidates.js
rm -f scripts/fill-missing-release-years.js
rm -f scripts/test-startgg-phases.js
rm -f scripts/test-startgg.js
rm -f scripts/verify-aliases-db.js
rm -f scripts/verify-aliases.js
rm -f scripts/verify-challonge-source.js

# Phase 5: Supprimer import-and-link-racetime.js (redondant)
echo "🗑️  Phase 5: Suppression script redondant"
rm -f scripts/import-and-link-racetime.js

# Phase 6: Supprimer migrations obsolètes
echo "🔄 Phase 6: Suppression migrations one-time"
rm -f scripts/migrations/bulk-convert-finishTimes.js
rm -f scripts/migrations/convert-race-finishTime.js
rm -f scripts/migrations/dry-run-convert-finishTimes.js
rm -f scripts/migrations/fix-race-urls.js
rm -f scripts/migrations/import-player-marco.js
rm -f scripts/migrations/cleanup-auto-created-games.js
rm -f scripts/migrations/migrate-add-game-ref.js
rm -f scripts/migrations/migrate-shortName-to-randomizer.js
rm -f scripts/migrations/update-tournament-gamenames.js

echo ""
echo "✅ Nettoyage terminé!"
echo ""
echo "📊 Résumé:"
echo "  - Avant: 63 scripts + 11 migrations"
echo "  - Après: 23 scripts + 1 migration"
echo "  - Supprimés: 40 scripts + 10 migrations"
echo ""
echo "📝 Scripts/migrations gardés:"
echo "   ✅ enrich-races.js → Maintenance enrichissement races"
echo "   ✅ unlink-race.js → Utilitaire détachement race"
echo "   ✅ enrich-twitch.js → Enrichissement optionnel Twitch"
echo "   ✅ link-race-to-match.js → Liaison race-match (maintenance)"
echo "   ✅ migrate-game-schema.js → Migration production"
echo ""
echo "🚀 Prochaines étapes:"
echo "   1. git add -A"
echo "   2. git commit -m '🧹 Cleanup: Supprimer 40 scripts + 10 migrations'"
echo "   3. npm run check-security (vérifier intégrité)"
echo "   4. git push"
