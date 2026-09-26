#!/usr/bin/env bash
# Build every release artifact from a git tag, on Linux, in throwaway containers:
#   Linux:   npm ci, npm test (full log kept), AppImage          node:22-bookworm
#   Windows: NSIS installer + portable exe                        node:22-bookworm + Debian's wine
#
#   scripts/build-release.sh v2.2.36 [--host user@buildhost]
#
# With --host (or R2SD_BUILD_HOST) the build runs on that machine over SSH; otherwise
# on this machine's Docker. The three artifacts land in release/ under the names
# scripts/publish-release.py expects, with the test log as release/last-test.txt
# (every run's log is also kept on the build machine in ~/r2sd-test-logs/).
#
# Why Wine: electron-builder generates the NSIS uninstaller by running the installer
# stub, and on Linux that needs Wine. Everything else (packaging, exe resources,
# makensis) works without it. Debian's own wine package is used rather than a
# third-party builder image, so the only sources are Debian and the npm lockfile.
#
# The build folder (R2SD_BUILD_DIR, default ~/r2sd-build) is emptied on every run
# except .cache/, which keeps the npm, Electron and electron-builder downloads between builds.
set -euo pipefail

IMAGE=node:22-bookworm

# ---- build side (runs on the build host, or locally) -------------------------
if [ "${1:-}" = "--remote" ]; then
  VERSION=$2 TARBALL=$3 DIR=$4
  case "$DIR" in /*) ;; *) DIR=$HOME/$DIR;; esac
  case "$DIR" in "" | / | "$HOME" | "$HOME/") echo "refusing to use $DIR as the build folder" >&2; exit 1;; esac
  mkdir -p "$DIR"
  cd "$DIR"
  find . -mindepth 1 -maxdepth 1 ! -name .cache -exec rm -rf {} +
  tar -xzf "$TARBALL"
  rm -f "$TARBALL"
  mkdir -p .home out
  U=$(id -u) G=$(id -g)
  run=(docker run --rm -v "$DIR":/work -w /work -e HOME=/work/.home
       -e ELECTRON_CACHE=/work/.cache/electron -e ELECTRON_BUILDER_CACHE=/work/.cache/electron-builder
       -e npm_config_cache=/work/.cache/npm)
  echo "== image $IMAGE $(docker image inspect -f '{{index .RepoDigests 0}}' "$IMAGE" 2>/dev/null || echo '(not pulled yet)')"

  echo "== Linux: npm ci, tests, AppImage"
  "${run[@]}" --name "Claude-r2sd-build-$VERSION" --user "$U:$G" "$IMAGE" bash -c < /dev/null '
    set -e
    npm ci --no-audit --no-fund
    npm run build
    if ! npm test > .home/last-test.txt 2>&1; then
      echo "TESTS FAILED - full log: .home/last-test.txt"; tail -40 .home/last-test.txt; exit 1
    fi
    grep -aE "(tests|pass|fail|cancelled|skipped) [0-9]+$" .home/last-test.txt
    npm run dist:linux' || status=$?
  # Every run's test log is kept (the downloads.test.js flake only shows up now and then).
  if [ -f .home/last-test.txt ]; then
    mkdir -p "$HOME/r2sd-test-logs"
    cp .home/last-test.txt "$HOME/r2sd-test-logs/test-$VERSION-$(date +%Y%m%d-%H%M%S).txt"
    cp .home/last-test.txt out/
  fi
  [ "${status:-0}" = 0 ] || exit "$status"
  mv release/RomM2SteamDeck.AppImage out/

  echo "== Windows: installer + portable (Debian wine)"
  # Starts as root only to apt-get install wine; the build itself runs as the calling user.
  "${run[@]}" --name "Claude-r2sd-build-win-$VERSION" -e WINEDEBUG=-all -e WINEDLLOVERRIDES=winemenubuilder.exe=d "$IMAGE" bash -c < /dev/null "
    set -e
    dpkg --add-architecture i386
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends wine wine32 wine64 > /dev/null
    echo \"== \$(wine --version)\"
    exec setpriv --reuid=$U --regid=$G --clear-groups npm run dist:win"
  mv "release/RomM2SteamDeck Setup $VERSION.exe" "release/RomM2SteamDeck-$VERSION-portable.exe" out/

  echo "== artifacts"
  (cd out && ls -l --time-style=+ -- *.AppImage *.exe && sha256sum -- *.AppImage *.exe)
  exit 0
fi

# ---- caller side --------------------------------------------------------------
TAG=${1:-}
[ -n "$TAG" ] && [ "${TAG#-}" = "$TAG" ] || { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 1; }
shift
HOST=${R2SD_BUILD_HOST:-}
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST=$2; shift 2;;
    *) echo "unknown option: $1" >&2; exit 1;;
  esac
done

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
git rev-parse -q --verify "refs/tags/$TAG" > /dev/null || { echo "no such tag: $TAG" >&2; exit 1; }
VERSION=$(git show "$TAG:package.json" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version')
[ "v$VERSION" = "$TAG" ] || { echo "$TAG does not match package.json version $VERSION" >&2; exit 1; }

BUILD_DIR=${R2SD_BUILD_DIR:-r2sd-build}   # relative = under the build machine's home
TARBALL=/tmp/r2sd-$VERSION-$$.tar.gz
git archive --format=tar.gz -o "$TARBALL" "$TAG"
mkdir -p release
rm -f release/RomM2SteamDeck.AppImage "release/RomM2SteamDeck Setup $VERSION.exe" "release/RomM2SteamDeck-$VERSION-portable.exe" release/last-test.txt
START=$(date +%s)

if [ -n "$HOST" ]; then
  echo "== building $TAG on $HOST"
  scp -q "$TARBALL" "$HOST:$TARBALL"
  rm -f "$TARBALL"
  ssh "$HOST" bash -s -- --remote "$VERSION" "$TARBALL" "$BUILD_DIR" < "$0"
  scp -q "$HOST:$BUILD_DIR/out/*" release/
else
  echo "== building $TAG with local Docker"
  bash "$0" --remote "$VERSION" "$TARBALL" "$BUILD_DIR"
  case "$BUILD_DIR" in /*) ;; *) BUILD_DIR=$HOME/$BUILD_DIR;; esac
  cp "$BUILD_DIR"/out/* release/
fi

echo "== done in $(( ($(date +%s) - START) / 60 )) min; release/ now has:"
ls -l release/RomM2SteamDeck.AppImage "release/RomM2SteamDeck Setup $VERSION.exe" "release/RomM2SteamDeck-$VERSION-portable.exe" release/last-test.txt
echo "next: python3 scripts/publish-release.py $VERSION <notes.md>"
