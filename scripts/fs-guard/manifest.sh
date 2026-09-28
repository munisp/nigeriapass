#!/bin/sh
# manifest.sh — generate a SHA256 manifest of the project's tracked files.
#
# Output: fs-guard.manifest at the repo root (one "sha256  path" line per file).
# Use before/after bulk operations to detect unintended modifications:
#   scripts/fs-guard/manifest.sh            # regenerate
#   scripts/fs-guard/manifest.sh --verify   # verify working tree vs manifest
#
# POSIX sh; depends only on coreutils (sha256sum, sort) and optionally git.

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
MANIFEST="$REPO_ROOT/fs-guard.manifest"
TMP="$MANIFEST.tmp.$$"
trap 'rm -f "$TMP"' EXIT

# Directories that are generated/disposable and never part of the manifest.
EXCLUDES='.git node_modules dist .webdev .manus-logs .turbo .next coverage'

list_files() {
  cd "$REPO_ROOT"
  if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git ls-files
  else
    # Fallback: walk the tree, pruning excluded directories.
    find . -type f \
      $(for d in $EXCLUDES; do printf '! -path "./%s" ! -path "./%s/*" ' "$d" "$d"; done) \
      ! -name 'fs-guard.manifest' -print |
      sed 's|^\./||' | LC_ALL=C sort
  fi
}

generate() {
  : >"$TMP"
  list_files | while IFS= read -r f; do
    # skip excluded dirs that git ls-files could theoretically include
    case "/$f" in
      */node_modules/*|*/.git/*|*/dist/*|*/.webdev/*|*/.manus-logs/*) continue ;;
    esac
    [ "$f" = "fs-guard.manifest" ] && continue
    [ -f "$REPO_ROOT/$f" ] || continue
    (cd "$REPO_ROOT" && sha256sum -- "$f")
  done >>"$TMP"
  LC_ALL=C sort -k2 "$TMP" -o "$TMP"
  mv "$TMP" "$MANIFEST"
  trap - EXIT
  echo "[fs-guard] manifest written: $MANIFEST ($(wc -l <"$MANIFEST" | tr -d ' ') files)"
}

verify() {
  if [ ! -f "$MANIFEST" ]; then
    echo "[fs-guard] ERROR: no manifest at $MANIFEST — run manifest.sh first" >&2
    exit 2
  fi
  cd "$REPO_ROOT"
  if sha256sum -c --quiet "$MANIFEST" >/dev/null 2>&1; then
    echo "[fs-guard] OK: working tree matches manifest"
    exit 0
  fi
  echo "[fs-guard] MISMATCHES DETECTED:" >&2
  sha256sum -c "$MANIFEST" 2>/dev/null | grep -v ': OK$' >&2 || true
  exit 1
}

case "${1:-}" in
  --verify|-v) verify ;;
  ""|--generate) generate ;;
  *) echo "usage: $0 [--verify]" >&2; exit 2 ;;
esac
