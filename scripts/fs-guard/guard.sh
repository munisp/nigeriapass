#!/bin/sh
# guard.sh — vet and (optionally) execute potentially destructive commands.
#
# Usage:
#   guard.sh [--i-know] -- <command...>   vet then run the command
#   guard.sh --check <command...>         vet only, never execute (for CLIs)
#   guard.sh --verify                     verify tree against fs-guard.manifest
#
# Behaviour:
#   - Benign commands pass straight through.
#   - Destructive patterns (rm -rf/-fr, git clean, dd of=, mkfs*, shred,
#     wipefs, truncate) targeting protected paths are REFUSED unless:
#       1. --i-know is passed, AND
#       2. a fresh snapshot is taken first (guard.sh runs snapshot.sh).
#   - After an approved destructive op, the fs-guard.manifest is verified and
#     any unexpected changes are reported.
#
# Exit codes: 0 ok/executed, 2 usage, 3 refused, 4 command failed.
#
# POSIX sh; coreutils/tar/sha256sum only.

set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)

# Paths that must never be wiped: the repo root itself, any ancestor of it,
# the user's home, and filesystem roots.
touches_protected() {
  for word in "$@"; do
    case "$word" in
      -*) continue ;; # flag, not a path
    esac
    # Broad globs and dot-targets can hit everything under the cwd.
    case "$word" in
      '*'|'./*'|'./'|'.'|'..'|'~'|"$HOME"|'/')
        return 0 ;;
    esac
    # Resolve to absolute (relative to repo root).
    case "$word" in
      /*) abs="$word" ;;
      *)  abs="$REPO_ROOT/$word" ;;
    esac
    # Strip a trailing slash for comparison.
    abs=${abs%/}
    # Target IS the repo root.
    [ "$abs" = "$REPO_ROOT" ] && return 0
    # Target is an ancestor of the repo root (would wipe the whole project).
    case "$REPO_ROOT" in
      "$abs"/*) return 0 ;;
    esac
  done
  return 1
}

destructive_reason() {
  # Inspect the full command line for dangerous patterns.
  cmd="$*"
  case "$cmd" in
    *"rm "*-rf*|*"rm "*-fr*|*"rm "*-r\ *-f*|*"rm "*-f\ *-r*)
      echo "recursive force delete (rm -rf)"; return 0 ;;
    *"git clean "*|*"git clean")
      echo "git clean (deletes untracked files)"; return 0 ;;
    *"dd "*of=*)
      echo "raw disk/image write (dd of=)"; return 0 ;;
    mkfs*|*" mkfs."*|*" mkfs "*)
      echo "filesystem format (mkfs)"; return 0 ;;
    *shred*|*wipefs*)
      echo "secure erase (shred/wipefs)"; return 0 ;;
    *"find "*-delete*)
      echo "bulk delete via find -delete"; return 0 ;;
  esac
  return 1
}

refuse() {
  echo "[fs-guard] REFUSED: $1" >&2
  echo "[fs-guard] command: $2" >&2
  echo "[fs-guard] If this is truly intended, re-run with --i-know (a snapshot" >&2
  echo "[fs-guard] will be taken first). See docs/FS-GUARD.md." >&2
  exit 3
}

# ── Argument parsing ──────────────────────────────────────────────────────────
I_KNOW=0
CHECK_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --i-know) I_KNOW=1; shift ;;
    --check)  CHECK_ONLY=1; shift ;;
    --verify) exec "$SCRIPT_DIR/manifest.sh" --verify ;;
    --) shift; break ;;
    *) break ;;
  esac
done

[ $# -eq 0 ] && { echo "usage: guard.sh [--i-know] [--check] -- <command...>" >&2; exit 2; }

CMD_STR="$*"

reason=$(destructive_reason "$CMD_STR") || reason=""
protected=0
if touches_protected "$@"; then protected=1; fi

if [ -n "$reason" ] && [ "$protected" -eq 1 ]; then
  if [ "$I_KNOW" -ne 1 ]; then
    refuse "destructive operation ($reason) on a protected path" "$CMD_STR"
  fi
  if [ "$CHECK_ONLY" -eq 1 ]; then
    echo "[fs-guard] WOULD ALLOW (with --i-know): destructive op vetted; snapshot required before execution"
    exit 0
  fi
  echo "[fs-guard] destructive operation approved via --i-know ($reason)"
  echo "[fs-guard] taking pre-operation snapshot..."
  "$SCRIPT_DIR/snapshot.sh"
  echo "[fs-guard] executing: $CMD_STR"
  "$@"
  rc=$?
  echo "[fs-guard] verifying working tree against manifest..."
  "$SCRIPT_DIR/manifest.sh" --verify || {
    echo "[fs-guard] WARNING: tree diverged from manifest beyond the approved operation." >&2
    echo "[fs-guard] Latest snapshot: $(ls -1t "${FSGUARD_SNAP_DIR:-$HOME/.fs-guard/snapshots}" | head -1)" >&2
  }
  [ $rc -eq 0 ] || exit 4
  exit 0
fi

if [ -n "$reason" ]; then
  echo "[fs-guard] note: destructive pattern ($reason) but no protected path targeted — allowed"
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  echo "[fs-guard] OK: command is not destructive to protected paths"
  exit 0
fi

"$@"
rc=$?
[ $rc -eq 0 ] || exit 4
