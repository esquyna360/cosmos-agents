#!/usr/bin/env bash
# Swaps /Applications/Cosmos.app for an already-downloaded bundle and wakes the
# agents that were mid-turn. Quitting the app kills every PTY, so this has to
# run detached from the session that calls it (release.sh does that).
#
#   swap-app.sh <new Cosmos.app | -> [id of the calling runner]
#
# "-" instead of a bundle only restarts the installed app.
# WAKE_ALSO="slug:name slug:name" wakes idle agents too.
#
# The app is opened with a clean environment: `open` hands its caller's
# environment on, and a Cosmos opened from inside a Claude Code session
# inherits CLAUDE_CODE_* (session id, message socket, CHILD_SESSION) and
# passes it to every agent, which then comes up and never answers.
set -uo pipefail

NEW_APP="$1"
SELF_ID="${2:-}"
DIR="$HOME/code/.dev-logs/cosmos-release"
mkdir -p "$DIR"
APP=/Applications/Cosmos.app
BACKUP="$DIR/Cosmos-anterior.app"
export COSMOS_SOCKET="$HOME/.cosmos/cosmos.sock"
unset COSMOS_PROJECT_ID COSMOS_PROJECT_SLUG COSMOS_RUNNER_ID
cli() { "$APP/Contents/MacOS/cosmos" "$@"; }
log() { echo "$(date '+%H:%M:%S') $*"; }

launch() {
  env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" SHELL=/bin/zsh \
    PATH=/usr/bin:/bin:/usr/sbin:/sbin TMPDIR="$(getconf DARWIN_USER_TEMP_DIR)" \
    /usr/bin/open -a "$APP"
}

wait_up() {
  for _ in $(seq 1 45); do
    cli status >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

cli status > "$DIR/status-antes.json" 2>/dev/null
WORKING="$(jq -r --arg me "$SELF_ID" \
  '.[] | .slug as $s | .runners[] | select(.status=="streaming" and .id!=$me) | "\($s)\t\(.id)\t\(.name)"' \
  "$DIR/status-antes.json")"
SELF_SLUG="$(jq -r --arg me "$SELF_ID" '.[] | .slug as $s | .runners[] | select(.id==$me) | $s' "$DIR/status-antes.json")"
log "trabalhando antes da troca:"; echo "$WORKING"

pkill -x agent-dashboard; pkill -x Cosmos
for _ in $(seq 1 20); do pgrep -x agent-dashboard >/dev/null || break; sleep 0.5; done
if [[ "$NEW_APP" != "-" ]]; then
  rm -rf "$BACKUP"
  mv "$APP" "$BACKUP"
  cp -R "$NEW_APP" "$APP"
  xattr -dr com.apple.quarantine "$APP" 2>/dev/null
  codesign --force --deep --sign - "$APP" >/dev/null 2>&1
fi
launch

if ! wait_up && [[ "$NEW_APP" == "-" ]]; then
  RESULT="FALHOU: o app não subiu em 90 s. Veja $DIR/swap.log."
elif ! wait_up; then
  log "app novo não subiu: voltando o anterior"
  pkill -x agent-dashboard
  rm -rf "$APP"; mv "$BACKUP" "$APP"; launch; wait_up
  RESULT="FALHOU: o app novo não subiu em 90 s e o anterior foi restaurado. Veja $DIR/swap.log."
else
  RESULT="O Cosmos foi aberto com ambiente limpo, versão $(defaults read "$APP/Contents/Info.plist" CFBundleShortVersionString)."
fi
log "$RESULT"
sleep 5

while IFS=$'\t' read -r slug id name; do
  [[ -z "$id" ]] && continue
  log "acordando $name ($slug)"
  cli runner send --project "$slug" --id "$id" --message "O Cosmos foi reiniciado agora para instalar uma atualização e isso interrompeu o seu turno. Nada mudou na sua tarefa: continue de onde parou." \
    || log "falhou ao acordar $name"
done <<< "$WORKING"
for extra in ${WAKE_ALSO:-}; do
  log "acordando também $extra"
  cli runner send --project "${extra%%:*}" --name "${extra##*:}" --message "O Cosmos foi reiniciado agora e isso encerrou o seu processo. Nada mudou na sua tarefa: se havia trabalho ou acompanhamento pendente, retome de onde parou." \
    || log "falhou ao acordar $extra"
done

if [[ -n "$SELF_SLUG" ]]; then
  cli runner send --project "$SELF_SLUG" --id "$SELF_ID" --message "Aviso do instalador destacado (scripts/swap-app.sh): $RESULT O log está em $DIR/swap.log. Continue a tarefa de onde parou." \
    || log "falhou ao acordar o próprio agente"
fi
cli status > "$DIR/status-depois.json" 2>/dev/null
log "fim"
