#!/usr/bin/env bash
# Release script for Cosmos. CI-first flow:
#
#   1. bump version in package.json / Cargo.toml / tauri.conf.json
#   2. commit + tag + push (origin)
#   3. GitHub Actions builds macOS (arm64) + Windows, signs the updater
#      tarball, and uploads everything to a GH release named after the tag
#   4. once the workflow finishes, download the macOS .app from the release
#      and install it to /Applications
#
# Usage:
#   scripts/release.sh                # patch bump (0.1.0 -> 0.1.1)
#   scripts/release.sh minor          # 0.1.0 -> 0.2.0
#   scripts/release.sh major          # 0.1.0 -> 1.0.0
#   scripts/release.sh 1.2.3          # explicit version
#
# Flags:
#   --no-install    don't touch /Applications/Cosmos.app after CI finishes
#   --no-watch      push tag and exit; don't wait for the Action
#   --dry-run       print plan, change nothing

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

PKG_JSON="$ROOT/package.json"
CARGO_TOML="$ROOT/src-tauri/Cargo.toml"
TAURI_CONF="$ROOT/src-tauri/tauri.conf.json"
APP_NAME="Cosmos"
APP_BUNDLE="/Applications/${APP_NAME}.app"
REPO_SLUG="esquyna360/cosmos-agents"

BUMP="patch"
DO_INSTALL=1
DO_WATCH=1
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    patch|minor|major) BUMP="$1"; shift ;;
    [0-9]*.[0-9]*.[0-9]*) BUMP="$1"; shift ;;
    --no-install) DO_INSTALL=0; shift ;;
    --no-watch) DO_WATCH=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

log()  { printf "\033[1;36m▶\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m!\033[0m %s\n" "$*"; }
die()  { printf "\033[1;31m✗\033[0m %s\n" "$*" >&2; exit 1; }
run()  { if [[ $DRY_RUN -eq 1 ]]; then echo "  + $*"; else eval "$@"; fi; }

# --- prerequisites -----------------------------------------------------------
for t in git jq gh python3; do
  command -v "$t" >/dev/null 2>&1 || die "Missing tool: $t"
done

# --- compute version ---------------------------------------------------------
CUR="$(jq -r .version "$PKG_JSON")"
[[ -z "$CUR" || "$CUR" == "null" ]] && die "Cannot read version from $PKG_JSON"
log "Current version: $CUR"

bump_semver() {
  local v="$1" kind="$2"
  IFS='.' read -r MA MI PA <<<"$v"
  case "$kind" in
    patch) PA=$((PA+1)) ;;
    minor) MI=$((MI+1)); PA=0 ;;
    major) MA=$((MA+1)); MI=0; PA=0 ;;
  esac
  echo "${MA}.${MI}.${PA}"
}

if [[ "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  NEW="$BUMP"
else
  NEW="$(bump_semver "$CUR" "$BUMP")"
fi
TAG="v$NEW"
log "Next version:    $NEW  ($TAG)"

# --- guard rails -------------------------------------------------------------
if [[ -n "$(git status --porcelain)" ]]; then
  die "Working tree not clean. Commit or stash before releasing."
fi
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  die "Tag $TAG already exists locally."
fi
if gh release view "$TAG" --repo "$REPO_SLUG" >/dev/null 2>&1; then
  die "Release $TAG already exists on GitHub."
fi

# --- bump versions -----------------------------------------------------------
log "Bumping version to $NEW"
run "jq --arg v '$NEW' '.version = \$v' '$PKG_JSON' > '$PKG_JSON.tmp' && mv '$PKG_JSON.tmp' '$PKG_JSON'"
run "jq --arg v '$NEW' '.version = \$v' '$TAURI_CONF' > '$TAURI_CONF.tmp' && mv '$TAURI_CONF.tmp' '$TAURI_CONF'"
if [[ $DRY_RUN -eq 0 ]]; then
  python3 - "$CARGO_TOML" "$NEW" <<'PY'
import re, sys, pathlib
path = pathlib.Path(sys.argv[1])
new = sys.argv[2]
text = path.read_text()
pkg_re = re.compile(r'(\[package\][^\[]*?version\s*=\s*")[^"]+(")', re.DOTALL)
text, n = pkg_re.subn(rf'\g<1>{new}\g<2>', text, count=1)
if n != 1:
    sys.exit("Could not find [package] version in Cargo.toml")
path.write_text(text)
PY
else
  echo "  + python3 update Cargo.toml [package] version to $NEW"
fi

# --- commit + tag + push -----------------------------------------------------
log "Committing version bump"
run "git add '$PKG_JSON' '$CARGO_TOML' '$TAURI_CONF'"
run "git commit -m 'Release $TAG'"
run "git tag -a '$TAG' -m '$TAG'"
log "Pushing commit + tag"
run "git push origin HEAD"
run "git push origin '$TAG'"

if [[ $DO_WATCH -eq 0 ]]; then
  log "--no-watch set; not waiting for the workflow."
  log "Track progress: https://github.com/${REPO_SLUG}/actions"
  exit 0
fi

# --- watch the workflow ------------------------------------------------------
log "Waiting for the Release workflow to start…"
if [[ $DRY_RUN -eq 1 ]]; then
  echo "  + gh run watch (the workflow triggered by tag $TAG)"
else
  # Poll until a run for our tag shows up (up to ~60s)
  RUN_ID=""
  for _ in $(seq 1 30); do
    RUN_ID="$(gh run list --repo "$REPO_SLUG" --workflow Release --limit 5 \
      --json databaseId,headBranch,event \
      --jq ".[] | select(.event==\"push\" and .headBranch==\"$TAG\") | .databaseId" \
      | head -n1)"
    [[ -n "$RUN_ID" ]] && break
    sleep 2
  done
  [[ -n "$RUN_ID" ]] || die "Could not find a workflow run for tag $TAG — check https://github.com/${REPO_SLUG}/actions"
  log "Watching run $RUN_ID"
  gh run watch "$RUN_ID" --repo "$REPO_SLUG" --exit-status \
    || die "Release workflow failed. See https://github.com/${REPO_SLUG}/actions/runs/$RUN_ID"
fi

# --- install macOS build locally --------------------------------------------
if [[ $DO_INSTALL -eq 1 ]]; then
  log "Downloading macOS bundle from release $TAG"
  WORK="$(mktemp -d -t cosmos-release-XXXXXX)"
  trap 'rm -rf "$WORK"' EXIT

  if [[ $DRY_RUN -eq 1 ]]; then
    echo "  + gh release download $TAG (mac tarball) -> $WORK"
  else
    # Tauri action uploads the updater bundle with a versioned name.
    # Fall back to glob in case naming differs.
    gh release download "$TAG" --repo "$REPO_SLUG" -D "$WORK" \
      --pattern "*aarch64*app.tar.gz" \
      || die "No macOS aarch64 app.tar.gz found in release $TAG"
    TARBALL="$(find "$WORK" -name "*aarch64*app.tar.gz" -print -quit)"
    [[ -n "$TARBALL" ]] || die "Downloaded but tarball not found"

    log "Extracting $(basename "$TARBALL")"
    tar -xzf "$TARBALL" -C "$WORK"
    APP_SRC="$(find "$WORK" -maxdepth 2 -name "${APP_NAME}.app" -print -quit)"
    [[ -n "$APP_SRC" && -d "$APP_SRC" ]] || die "Tarball did not contain ${APP_NAME}.app"

    log "Installing to $APP_BUNDLE"
    pkill -x "agent-dashboard" 2>/dev/null || true
    pkill -x "${APP_NAME}" 2>/dev/null || true
    sleep 1
    rm -rf "$APP_BUNDLE"
    cp -R "$APP_SRC" "$APP_BUNDLE"
    codesign --force --deep --sign - "$APP_BUNDLE" >/dev/null 2>&1 || true
    log "Installed $APP_NAME $NEW. Launch: open -a $APP_NAME"
  fi
fi

log "All done. v$NEW shipped — https://github.com/${REPO_SLUG}/releases/tag/$TAG"
