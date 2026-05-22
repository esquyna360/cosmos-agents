#!/usr/bin/env bash
# Release script for Cosmos.
#
# Usage:
#   scripts/release.sh patch              # 0.1.0 -> 0.1.1 (default)
#   scripts/release.sh minor              # 0.1.0 -> 0.2.0
#   scripts/release.sh major              # 0.1.0 -> 1.0.0
#   scripts/release.sh 1.2.3              # explicit version
#
# Flags:
#   --no-release    bump + build + install locally; skip git tag and GH release
#   --no-install    bump + build + release; don't touch /Applications/Cosmos.app
#   --no-push       create tag locally but don't push to origin
#   --dry-run       print the planned actions, change nothing
#   --notes "..."   release notes body (default: commits since last tag)

set -euo pipefail

# --- locate repo root (script lives in scripts/) -----------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

PKG_JSON="$ROOT/package.json"
CARGO_TOML="$ROOT/src-tauri/Cargo.toml"
TAURI_CONF="$ROOT/src-tauri/tauri.conf.json"
APP_NAME="Cosmos"
APP_BUNDLE="/Applications/${APP_NAME}.app"

# --- args --------------------------------------------------------------------
BUMP="patch"
DO_RELEASE=1
DO_INSTALL=1
DO_PUSH=1
DRY_RUN=0
NOTES=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    patch|minor|major) BUMP="$1"; shift ;;
    [0-9]*.[0-9]*.[0-9]*) BUMP="$1"; shift ;;
    --no-release) DO_RELEASE=0; shift ;;
    --no-install) DO_INSTALL=0; shift ;;
    --no-push) DO_PUSH=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --notes) NOTES="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

log()  { printf "\033[1;36m▶\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m!\033[0m %s\n" "$*"; }
die()  { printf "\033[1;31m✗\033[0m %s\n" "$*" >&2; exit 1; }
run()  { if [[ $DRY_RUN -eq 1 ]]; then echo "  + $*"; else eval "$@"; fi; }

# --- prerequisites -----------------------------------------------------------
need() {
  command -v "$1" >/dev/null 2>&1 || die "Missing tool: $1 — install it and retry."
}
need git
need jq
need gh
[[ $DO_RELEASE -eq 1 ]] && need gh
# pnpm + cargo only needed for the actual build
command -v pnpm >/dev/null 2>&1 || die "pnpm not on PATH — install via 'corepack enable pnpm' or 'brew install pnpm'."
command -v cargo >/dev/null 2>&1 || die "cargo not on PATH — install via 'curl https://sh.rustup.rs -sSf | sh'."

# --- current version ---------------------------------------------------------
CUR="$(jq -r .version "$PKG_JSON")"
[[ -z "$CUR" || "$CUR" == "null" ]] && die "Cannot read version from $PKG_JSON"
log "Current version: $CUR"

# --- compute next version ----------------------------------------------------
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
log "Next version:    $NEW"
TAG="v$NEW"

# --- guard against dirty tree / existing tag ---------------------------------
if [[ $DO_RELEASE -eq 1 ]]; then
  if [[ -n "$(git status --porcelain)" ]]; then
    die "Working tree not clean. Commit or stash before releasing."
  fi
  if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
    die "Tag $TAG already exists locally."
  fi
  if gh release view "$TAG" >/dev/null 2>&1; then
    die "Release $TAG already exists on GitHub."
  fi
fi

# --- write new versions ------------------------------------------------------
log "Writing version $NEW to package.json / Cargo.toml / tauri.conf.json"

# package.json
run "jq --arg v '$NEW' '.version = \$v' '$PKG_JSON' > '$PKG_JSON.tmp' && mv '$PKG_JSON.tmp' '$PKG_JSON'"

# tauri.conf.json
run "jq --arg v '$NEW' '.version = \$v' '$TAURI_CONF' > '$TAURI_CONF.tmp' && mv '$TAURI_CONF.tmp' '$TAURI_CONF'"

# Cargo.toml — replace only the [package] version line at top of file.
# Match the first 'version = "x.y.z"' (which is the package version) using sed.
if [[ $DRY_RUN -eq 0 ]]; then
  # Use a Python one-liner to be safe with TOML formatting
  python3 - "$CARGO_TOML" "$NEW" <<'PY'
import re, sys, pathlib
path = pathlib.Path(sys.argv[1])
new = sys.argv[2]
text = path.read_text()
# Replace the version under the FIRST [package] section only.
pkg_re = re.compile(r'(\[package\][^\[]*?version\s*=\s*")[^"]+(")', re.DOTALL)
text, n = pkg_re.subn(rf'\g<1>{new}\g<2>', text, count=1)
if n != 1:
    sys.exit("Could not find [package] version in Cargo.toml")
path.write_text(text)
PY
else
  echo "  + python3 update Cargo.toml [package] version to $NEW"
fi

# --- signing key for updater -------------------------------------------------
# Tauri's updater requires the bundle to be signed with a minisign keypair.
# Private key lives outside the repo. Override location with COSMOS_SIGNING_KEY.
SIGNING_KEY="${COSMOS_SIGNING_KEY:-$HOME/.cosmos-signing/cosmos.key}"
if [[ ! -f "$SIGNING_KEY" ]]; then
  die "Signing key not found at $SIGNING_KEY — generate with 'pnpm tauri signer generate --ci -w $SIGNING_KEY'"
fi
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$SIGNING_KEY")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${COSMOS_SIGNING_PASSWORD:-}"

# --- build -------------------------------------------------------------------
log "Installing JS deps"
run "pnpm install --frozen-lockfile"

log "Building Tauri bundle (arm64, release, signed for updater)"
run "pnpm tauri build"

# --- locate build artifacts --------------------------------------------------
BUNDLE_DIR="$ROOT/src-tauri/target/release/bundle"
APP_SRC="$BUNDLE_DIR/macos/${APP_NAME}.app"
DMG_SRC="$(find "$BUNDLE_DIR/dmg" -name "${APP_NAME}_${NEW}_*.dmg" -print -quit 2>/dev/null || true)"
UPDATER_TARBALL="$(find "$BUNDLE_DIR/macos" -name "${APP_NAME}.app.tar.gz" -print -quit 2>/dev/null || true)"
UPDATER_SIG="$(find "$BUNDLE_DIR/macos" -name "${APP_NAME}.app.tar.gz.sig" -print -quit 2>/dev/null || true)"

if [[ $DRY_RUN -eq 0 ]]; then
  [[ -d "$APP_SRC" ]] || die "Build did not produce $APP_SRC"
  [[ -n "$DMG_SRC" && -f "$DMG_SRC" ]] || die "Build did not produce a .dmg in $BUNDLE_DIR/dmg"
  [[ -n "$UPDATER_TARBALL" && -f "$UPDATER_TARBALL" ]] || die "Missing updater tarball ${APP_NAME}.app.tar.gz"
  [[ -n "$UPDATER_SIG" && -f "$UPDATER_SIG" ]] || die "Missing updater signature ${APP_NAME}.app.tar.gz.sig"
  log "Built: $DMG_SRC"
fi

# --- local install -----------------------------------------------------------
if [[ $DO_INSTALL -eq 1 ]]; then
  log "Installing to $APP_BUNDLE"
  run "pkill -x 'agent-dashboard' 2>/dev/null || true"
  run "pkill -x '${APP_NAME}' 2>/dev/null || true"
  # give the process a second to actually exit so we can delete its bundle
  run "sleep 1"
  run "rm -rf '$APP_BUNDLE'"
  run "cp -R '$APP_SRC' '$APP_BUNDLE'"
  # ad-hoc resign so launchd doesn't complain about modified bundle
  run "codesign --force --deep --sign - '$APP_BUNDLE' >/dev/null 2>&1 || true"
  log "Installed $APP_NAME $NEW. Launch with: open -a $APP_NAME"
fi

# --- release -----------------------------------------------------------------
if [[ $DO_RELEASE -eq 1 ]]; then
  log "Committing version bump"
  run "git add '$PKG_JSON' '$CARGO_TOML' '$TAURI_CONF'"
  run "git commit -m 'Release $TAG'"
  run "git tag -a '$TAG' -m '$TAG'"

  if [[ $DO_PUSH -eq 1 ]]; then
    log "Pushing commit + tag"
    run "git push origin HEAD"
    run "git push origin '$TAG'"
  else
    warn "--no-push set; tag $TAG is local only"
  fi

  # Compute release notes from commits since last tag if not provided
  if [[ -z "$NOTES" ]]; then
    PREV_TAG="$(git describe --tags --abbrev=0 "$TAG^" 2>/dev/null || true)"
    if [[ -n "$PREV_TAG" ]]; then
      NOTES="$(git log --pretty=format:'- %s' "$PREV_TAG..$TAG")"
    else
      NOTES="First release."
    fi
  fi

  # Renamed updater artifacts include the version + arch so each release has
  # unique filenames (avoids collisions when GitHub's "latest" CDN caches).
  UPDATER_TARBALL_VER="${BUNDLE_DIR}/macos/${APP_NAME}_${NEW}_aarch64.app.tar.gz"
  UPDATER_SIG_VER="${UPDATER_TARBALL_VER}.sig"
  if [[ $DRY_RUN -eq 0 ]]; then
    cp "$UPDATER_TARBALL" "$UPDATER_TARBALL_VER"
    cp "$UPDATER_SIG" "$UPDATER_SIG_VER"
  fi

  # Build latest.json for tauri-plugin-updater
  LATEST_JSON="${BUNDLE_DIR}/macos/latest.json"
  PUB_DATE="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  REPO_SLUG="esquyna360/cosmos-agents"
  TARBALL_URL="https://github.com/${REPO_SLUG}/releases/download/${TAG}/${APP_NAME}_${NEW}_aarch64.app.tar.gz"

  if [[ $DRY_RUN -eq 0 ]]; then
    SIG_CONTENT="$(cat "$UPDATER_SIG")"
    NOTES_JSON="$(printf '%s' "$NOTES" | jq -Rs .)"
    cat > "$LATEST_JSON" <<JSON
{
  "version": "${NEW}",
  "notes": ${NOTES_JSON},
  "pub_date": "${PUB_DATE}",
  "platforms": {
    "darwin-aarch64": {
      "signature": "${SIG_CONTENT}",
      "url": "${TARBALL_URL}"
    }
  }
}
JSON
  fi

  log "Creating GitHub release $TAG"
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "  + gh release create $TAG --title $TAG --notes ... $DMG_SRC $UPDATER_TARBALL_VER $UPDATER_SIG_VER $LATEST_JSON"
  else
    gh release create "$TAG" \
      --title "$TAG" \
      --notes "$NOTES" \
      "$DMG_SRC#${APP_NAME} ${NEW} (arm64 dmg)" \
      "$UPDATER_TARBALL_VER#${APP_NAME} ${NEW} (updater tarball)" \
      "$UPDATER_SIG_VER#${APP_NAME} ${NEW} (signature)" \
      "$LATEST_JSON#updater manifest"
  fi
  log "Done — https://github.com/esquyna360/cosmos-agents/releases/tag/$TAG"
fi

log "All done. v$NEW shipped."
