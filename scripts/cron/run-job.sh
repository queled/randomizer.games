#!/usr/bin/env bash
# Tâches récurrentes du serveur de production, lancées par la crontab
# (voir docs/DEPLOYMENT.md). Elles reprennent les workflows GitHub Actions,
# qui ne peuvent pas joindre une base MongoDB fermée au réseau.
#
# Usage : scripts/cron/run-job.sh <tâche>
#   racetime              nouvelles courses racetime.gg            (toutes les 5 min)
#   tournaments-update    tournois actifs + rattachement des courses (toutes les 15 min)
#   schedule-sites        horaires, restreams et VOD des races (Mido's House, Hyrule Town Hall), saison de League, VOD Speedrace, plannings localhorst et iCal (toutes les 15 min)
#   race-vods             VOD Twitch des joueurs, restreams trouvés sur Twitch (toutes les 30 min)
#   tournaments-discover  nouveaux tournois des 2 derniers jours, asyncs ALTTPR, saison de l'ALTTPR League (tous les jours)
#   rando-list            cache rando-list, si le dépôt a changé    (tous les jours)
#   players               joueurs et profils racetime.gg, comptes des participants (tous les jours)
#   challonge-check       une requête pour savoir si le quota Challonge est revenu (tous les jours)
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

run_schedule_sites() {
  local status=0
  timeout 8m node scripts/sync-schedule-sites.js || status=$?
  timeout 5m node scripts/sync-midos-league.js --current || status=$?
  timeout 2m node scripts/sync-speedrace.js || status=$?
  timeout 3m node scripts/sync-localhorst.js || status=$?
  timeout 3m node scripts/sync-ical-restreams.js || status=$?
  return "$status"
}

run_race_vods() {
  local status=0
  timeout 10m node scripts/sync-race-vods.js || status=$?
  timeout 10m node scripts/sync-race-restreams.js || status=$?
  return "$status"
}

run_tournaments_discover() {
  local since
  since="$(date -u -d '-2 days' +%Y-%m-%d)"
  local status=0
  timeout 15m node scripts/discover-tournaments.js --since "$since" --max-pages 3 || status=$?
  timeout 5m node scripts/sync-alttpr-asyncs.js || status=$?
  timeout 10m node scripts/sync-alttpr-league.js --current || status=$?
  return "$status"
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

run_players() {
  local status=0
  timeout 10m node scripts/sync-players-from-races.js || status=$?
  # 1/7 des profils par jour : chacun est relu chaque semaine
  timeout 40m node scripts/sync-racetime-profiles.js --stale-days 7 --limit 1200 || status=$?
  timeout 20m node scripts/link-participant-accounts.js --all --apply || status=$?
  return "$status"
}

run_challonge_check() {
  timeout 2m node scripts/check-challonge-quota.js
}

run_backup() {
  timeout 30m node scripts/backup-db.js
}

case "$JOB" in
  racetime)             fn=run_racetime ;;
  tournaments-update)   fn=run_tournaments_update ;;
  schedule-sites)       fn=run_schedule_sites ;;
  race-vods)            fn=run_race_vods ;;
  tournaments-discover) fn=run_tournaments_discover ;;
  rando-list)           fn=run_rando_list ;;
  players)              fn=run_players ;;
  challonge-check)      fn=run_challonge_check ;;
  backup)               fn=run_backup ;;
  *)
    echo "Usage: $0 <racetime|tournaments-update|schedule-sites|race-vods|tournaments-discover|rando-list|players|challonge-check|backup>" >&2
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

# État de la dernière exécution, lu par la page de santé du panneau admin
# (services/job-health.js) : $LOG_DIR/status/<tâche>.json
STATUS_FILE="$LOG_DIR/status/$JOB.json"
mkdir -p "$LOG_DIR/status"

status_field() {
  sed -n "s/.*\"$1\": *\"\{0,1\}\([^\",}]*\).*/\1/p" "$STATUS_FILE" 2>/dev/null | head -n 1
}

write_status() {
  printf '{"job":"%s","state":"%s","startedAt":"%s","endedAt":"%s","exitCode":%s,"lastSuccessAt":"%s","consecutiveFailures":%s}\n' \
    "$JOB" "$1" "$started_at" "$2" "$3" "$last_success" "$failures" >"$STATUS_FILE.tmp" &&
    mv "$STATUS_FILE.tmp" "$STATUS_FILE"
}

last_success="$(status_field lastSuccessAt)"
failures="$(status_field consecutiveFailures)"
failures="${failures:-0}"
previous_end="$(status_field endedAt)"
previous_code="$(status_field exitCode)"
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
write_status running "$previous_end" "${previous_code:-null}"

log "début $JOB"
"$fn"
status=$?
log "fin $JOB (code $status)"

if [ "$status" -eq 0 ]; then
  last_success="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  failures=0
else
  failures=$((failures + 1))
fi
write_status done "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$status"
exit "$status"
