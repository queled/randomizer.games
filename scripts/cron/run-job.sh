#!/usr/bin/env bash
# Tâches récurrentes du serveur de production, lancées par la crontab
# (voir docs/DEPLOYMENT.md). Elles reprennent les workflows GitHub Actions,
# qui ne peuvent pas joindre une base MongoDB fermée au réseau.
#
# Usage : scripts/cron/run-job.sh <tâche>
#   racetime              nouvelles courses racetime.gg            (toutes les 5 min)
#   tournaments-update    tournois actifs + rattachement des courses (toutes les 15 min)
#   tournaments-discover  nouveaux tournois des 2 derniers jours    (tous les jours)
#   rando-list            cache rando-list, si le dépôt a changé    (tous les jours)
#   backup                mongodump avec rotation                   (toutes les nuits)
#
# Chaque tâche écrit dans $LOG_DIR/<tâche>.log (~/logs par défaut). Un verrou
# empêche deux exécutions simultanées : si la précédente tourne encore, la
# nouvelle s'arrête sans rien faire.

set -uo pipefail

APP_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
LOG_DIR="${LOG_DIR:-$HOME/logs}"
JOB="${1:-}"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

run_racetime() {
  timeout 10m node scripts/sync-racetime-global.js
}

run_tournaments_update() {
  local status=0
  timeout 10m node scripts/sync-tournaments.js --update-only || status=$?
  timeout 10m node scripts/auto-link-tournaments.js || status=$?
  return "$status"
}

run_tournaments_discover() {
  local since
  since="$(date -u -d '-2 days' +%Y-%m-%d)"
  timeout 15m node scripts/discover-tournaments.js --since "$since" --max-pages 3
}

run_rando_list() {
  local dir="${RANDO_LIST_DIR:-$APP_DIR/scripts/tmp/rando-list}"
  local repo="${RANDO_LIST_REPO:-https://github.com/video-game-randomizers/rando-list.git}"
  local branch="${RANDO_LIST_BRANCH:-main}"

  if [ -d "$dir/.git" ]; then
    git -C "$dir" fetch --depth 1 origin "$branch" && git -C "$dir" reset --hard "origin/$branch" || return 1
  else
    mkdir -p "$(dirname "$dir")"
    git clone --depth 1 --branch "$branch" "$repo" "$dir" || return 1
  fi

  local commit check
  commit="$(git -C "$dir" rev-parse HEAD)"
  check="$(RANDO_LIST_DIR="$dir" node scripts/check-rando-list-changes.js --commit "$commit")"

  # Le script répond hasChanges=true en cas de doute : on ne saute la
  # synchronisation que s'il confirme que ce commit est déjà en base.
  if [[ "$check" == *'"hasChanges":false'* ]]; then
    log "rando-list inchangé ($commit)"
    return 0
  fi

  RANDO_LIST_DIR="$dir" timeout 15m node scripts/sync-rando-list.js --detect-new
}

run_backup() {
  timeout 30m node scripts/backup-db.js
}

case "$JOB" in
  racetime)             fn=run_racetime ;;
  tournaments-update)   fn=run_tournaments_update ;;
  tournaments-discover) fn=run_tournaments_discover ;;
  rando-list)           fn=run_rando_list ;;
  backup)               fn=run_backup ;;
  *)
    echo "Usage: $0 <racetime|tournaments-update|tournaments-discover|rando-list|backup>" >&2
    exit 2
    ;;
esac

mkdir -p "$LOG_DIR"
exec >>"$LOG_DIR/$JOB.log" 2>&1

exec 9>"${TMPDIR:-/tmp}/randomizer-$JOB.lock"
if ! flock -n 9; then
  log "$JOB : l'exécution précédente tourne encore, on passe"
  exit 0
fi

cd "$APP_DIR" || exit 1

log "début $JOB"
"$fn"
status=$?
log "fin $JOB (code $status)"
exit "$status"
