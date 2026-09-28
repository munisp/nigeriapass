# FS-GUARD — Filesystem Anti-Wipe Protection Policy

This repository ships a lightweight anti-wipe layer (`scripts/fs-guard/`) that
protects the project filesystem from **accidental destructive wipes by AI
agents and shell-driving CLIs** (e.g. kimi) as well as human fat-fingers.

## Rules for AI agents operating in this repo

1. **Never** run `rm -rf`, `git clean -fdx`, `dd of=`, `mkfs.*`, `shred`,
   `wipefs`, or `find ... -delete` against the project directory, its
   ancestors, `$HOME`, or filesystem roots.
2. **Always snapshot first** before any bulk operation (mass deletes, mass
   rewrites, migrations over many files):
   ```sh
   scripts/fs-guard/snapshot.sh
   ```
3. **Route unavoidable destructive commands through the guard**:
   ```sh
   scripts/fs-guard/guard.sh --check -- <command>   # vet only
   scripts/fs-guard/guard.sh --i-know -- <command>  # snapshot + execute
   ```
   Without `--i-know`, destructive commands on protected paths are refused
   (exit code 3).
4. **Verify the manifest after bulk ops** to prove nothing unexpected changed:
   ```sh
   scripts/fs-guard/manifest.sh --verify
   ```
5. Prefer targeted edits over delete-and-recreate. Never "clean up"
   directories you did not create. When in doubt, snapshot — it costs seconds.

## Components

| Script                            | Purpose                                                        |
| --------------------------------- | -------------------------------------------------------------- |
| `scripts/fs-guard/manifest.sh`    | Generate/verify `fs-guard.manifest` (SHA256 of tracked files)  |
| `scripts/fs-guard/guard.sh`       | Vet destructive commands; refuse unless `--i-know` + snapshot  |
| `scripts/fs-guard/snapshot.sh`    | Timestamped `tar.gz` source snapshots → `~/.fs-guard/snapshots/` (keeps last 10) |
| `scripts/fs-guard/install-hook.sh`| Optional shell aliases (`srm`, `fsguard`, `fssnap`) + writes the `~/.fs-guard/kimi-guard.md` policy note for agent CLIs |

All scripts are POSIX sh and depend only on coreutils, tar, and sha256sum.
On filesystems that do not persist executable bits (e.g. some FUSE/9p
mounts — chmod appears to succeed but the mode stays 0644), invoke them
explicitly through the shell: `sh scripts/fs-guard/guard.sh -- <cmd>`.

## Typical workflow

```sh
# One-time: generate the integrity baseline
scripts/fs-guard/manifest.sh

# Optional: install shell helpers
scripts/fs-guard/install-hook.sh

# Before a risky refactor:
fssnap                                # or scripts/fs-guard/snapshot.sh

# A dangerous command is refused:
guard.sh -- rm -rf .                  # → REFUSED, exit 3

# Approved path (auto-snapshots, executes, then verifies the manifest):
guard.sh --i-know -- rm -rf dist

# Verify nothing unexpected changed:
guard.sh --verify
```

## Recovery

Snapshots are source-only (they exclude `node_modules`, `dist`, `.git`,
logs). To recover after a wipe:

```sh
mkdir restored && tar -xzf ~/.fs-guard/snapshots/<project>-<timestamp>.tar.gz -C restored
# then reinstall deps and rebuild
pnpm install --frozen-lockfile
```

## Scope and limits

- fs-guard is a **safety net against accidents**, not a security boundary;
  a determined process can bypass it.
- Protected paths: the repo root, its ancestors, `$HOME`, and `/`.
- The manifest covers tracked files (via `git ls-files`, or a `find` fallback
  that prunes generated directories). Regenerate it after large legitimate
  changes so `--verify` stays meaningful.
