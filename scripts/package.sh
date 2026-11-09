#!/usr/bin/env bash
#
# Package the plugin for installation. This does not build anything: the
# source file is already the bundle. It only arranges the three files the
# installer expects at the root of the ZIP.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="$ROOT/block-domain"
OUT_DIR="$ROOT/dist"
OUT_FILE="$OUT_DIR/block-domain.zip"

for file in "$PLUGIN_DIR/manifest.json" "$PLUGIN_DIR/icon.png" "$PLUGIN_DIR/src/index.js"; do
  if [[ ! -f "$file" ]]; then
    echo "Missing required file: $file" >&2
    exit 1
  fi
done

if ! command -v zip >/dev/null 2>&1; then
  echo "The 'zip' command is required." >&2
  exit 1
fi

icon_bytes="$(wc -c < "$PLUGIN_DIR/icon.png")"
if (( icon_bytes > 262144 )); then
  echo "icon.png is ${icon_bytes} bytes; the limit is 262144 bytes (256 KB)." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/block-domain-package.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

cp "$PLUGIN_DIR/manifest.json" "$STAGE/manifest.json"
cp "$PLUGIN_DIR/icon.png" "$STAGE/icon.png"
cp "$PLUGIN_DIR/src/index.js" "$STAGE/index.js"

# The manifest points at index.js at the archive root; never ship src/ paths.
rm -f "$OUT_FILE"
(
  cd "$STAGE"
  zip -q -X "$OUT_FILE" manifest.json icon.png index.js
)

entries="$(unzip -Z1 "$OUT_FILE" | sort)"
expected=$'icon.png\nindex.js\nmanifest.json'
if [[ "$entries" != "$expected" ]]; then
  echo "Unexpected ZIP contents:" >&2
  printf '%s\n' "$entries" >&2
  exit 1
fi

echo "Wrote $OUT_FILE"
sha256sum "$OUT_FILE"
