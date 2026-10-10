#!/usr/bin/env bash
# Installs the pinned CodexBar CLI (third-party, MIT) OUTSIDE the repo and verifies its SHA256.
#   scripts/install-codexbar.sh [dest_dir]     (default: ${GATESWARM_TOOLS_DIR:-$HOME/.local/share/gateswarm}/codexbar)
# Then export GATESWARM_CODEXBAR_BIN=<dest_dir>/codexbar for scripts/quota-sync.py.
# Linux x86_64 only. Bumping the version means re-verifying the hash yourself:
#   sha256sum CodexBarCLI-vX-linux-x86_64.tar.gz   (compare with the release page before updating the pin below)
set -euo pipefail
VERSION="0.73.0"
SHA256="a84f556c7ecebc8e606e0a34ee0d121626f72d7afc1e3adf5746410bc10f9611"
ASSET="CodexBarCLI-v${VERSION}-linux-x86_64.tar.gz"
URL="https://github.com/steipete/CodexBar/releases/download/v${VERSION}/${ASSET}"
DEST="${1:-${GATESWARM_TOOLS_DIR:-$HOME/.local/share/gateswarm}/codexbar}"
[ "$(uname -m)" = "x86_64" ] || { echo "unsupported arch $(uname -m)"; exit 2; }
if [ -x "$DEST/codexbar" ] && [ "$("$DEST/codexbar" --version 2>/dev/null | head -1)" = "CodexBar ${VERSION}" ]; then echo "already installed: $DEST/codexbar"; exit 0; fi
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/$ASSET" "$URL"
echo "${SHA256}  $TMP/$ASSET" | sha256sum -c - >/dev/null || { echo "SHA256 mismatch — aborting" >&2; exit 3; }
mkdir -p "$DEST"; tar -xzf "$TMP/$ASSET" -C "$DEST"
echo "installed CodexBar ${VERSION} -> $DEST (set GATESWARM_CODEXBAR_BIN=$DEST/codexbar)"
