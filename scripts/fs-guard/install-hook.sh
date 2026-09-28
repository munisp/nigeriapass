#!/bin/sh
# install-hook.sh — optional fs-guard shell integration installer.
#
# What it does (all optional, idempotent, reversible):
#   1. Adds a guarded `rm`-style helper + `fsguard` alias block to your
#      ~/.profile (or the file given by --rc) between markers so it can be
#      removed cleanly with --uninstall.
#   2. Writes ~/.fs-guard/kimi-guard.md — a policy note for AI agent CLIs
#      (kimi and similar) instructing them to route destructive filesystem
#      commands through guard.sh.
#
# It deliberately does NOT alias plain `rm` globally — that breaks scripts.
# Instead it installs a `srm` ("safe rm") function and a `fsguard` shortcut.
#
# Usage:
#   install-hook.sh              install into ~/.profile
#   install-hook.sh --rc FILE    install into a specific rc file
#   install-hook.sh --uninstall  remove the alias block
#
# POSIX sh; coreutils only.

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
FSGUARD_HOME="${FSGUARD_HOME:-$HOME/.fs-guard}"

BEGIN_MARK='# >>> fs-guard (nigerianpass) >>>'
END_MARK='# <<< fs-guard (nigerianpass) <<<'

RC_FILE="$HOME/.profile"
UNINSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --rc) RC_FILE="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) echo "usage: $0 [--rc FILE] [--uninstall]" >&2; exit 2 ;;
  esac
done

mkdir -p "$FSGUARD_HOME"

# ── Agent CLI policy note (kimi-guard) ────────────────────────────────────────
cat >"$FSGUARD_HOME/kimi-guard.md" <<EOF
# kimi-guard — filesystem anti-wipe policy for AI agent CLIs

This workspace (${REPO_ROOT}) is protected by fs-guard
(${REPO_ROOT}/scripts/fs-guard/). Agent CLIs (kimi, and any other automated
shell-driving assistant) MUST follow these rules when operating here:

1. NEVER run \`rm -rf\`, \`git clean -fdx\`, \`dd of=\`, \`mkfs.*\`, \`shred\`,
   \`wipefs\`, or \`find ... -delete\` against the project directory, its
   ancestors, \$HOME, or filesystem roots.
2. Route any unavoidable destructive command through the vetter:
       ${REPO_ROOT}/scripts/fs-guard/guard.sh --check -- <command>
   and execute only via:
       ${REPO_ROOT}/scripts/fs-guard/guard.sh --i-know -- <command>
   (guard.sh takes a snapshot automatically before executing).
3. Before any bulk file operation, take a snapshot:
       ${REPO_ROOT}/scripts/fs-guard/snapshot.sh
4. After any bulk operation, verify integrity:
       ${REPO_ROOT}/scripts/fs-guard/manifest.sh --verify
5. Prefer targeted file edits over delete-and-recreate. Never "clean up"
   directories you did not create.

Full policy: ${REPO_ROOT}/docs/FS-GUARD.md
EOF
echo "[fs-guard] wrote $FSGUARD_HOME/kimi-guard.md"

# ── RC file block ─────────────────────────────────────────────────────────────
if [ "$UNINSTALL" -eq 1 ]; then
  if [ -f "$RC_FILE" ] && grep -qF "$BEGIN_MARK" "$RC_FILE"; then
    tmp="$RC_FILE.tmp.$$"
    sed "/$(printf '%s' "$BEGIN_MARK" | sed 's/[][\.*^$/]/\\&/g')/,/$(printf '%s' "$END_MARK" | sed 's/[][\.*^$/]/\\&/g')/d" "$RC_FILE" >"$tmp"
    mv "$tmp" "$RC_FILE"
    echo "[fs-guard] removed alias block from $RC_FILE"
  else
    echo "[fs-guard] no fs-guard block found in $RC_FILE"
  fi
  exit 0
fi

if [ -f "$RC_FILE" ] && grep -qF "$BEGIN_MARK" "$RC_FILE"; then
  echo "[fs-guard] already installed in $RC_FILE (nothing to do)"
  exit 0
fi

cat >>"$RC_FILE" <<EOF
$BEGIN_MARK
# Safe-delete helper: vets rm through fs-guard. Plain 'rm' is untouched.
srm() { "$REPO_ROOT/scripts/fs-guard/guard.sh" -- rm "\$@"; }
# Vet/execute any risky command: fsguard rm -rf somedir
fsguard() { "$REPO_ROOT/scripts/fs-guard/guard.sh" -- "\$@"; }
# Quick snapshot of the project source.
fssnap() { "$REPO_ROOT/scripts/fs-guard/snapshot.sh"; }
$END_MARK
EOF

echo "[fs-guard] installed shell block into $RC_FILE"
echo "[fs-guard] restart your shell or run: . $RC_FILE"
echo "[fs-guard] helpers available: srm (safe rm), fsguard (vet+run), fssnap (snapshot)"
