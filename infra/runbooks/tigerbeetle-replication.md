# Runbook: TigerBeetle replication (single replica → 3-node cluster)

The compose `core` profile runs ONE replica (`--replica-count=1`, `--development`).
That is a correctness ledger, not an HA ledger. Graduate when wallet balances
become authoritative (postgres becomes the cache).

## Topology (target)
3 replicas, cluster 0, addresses pinned per replica. TB's consensus (VSR)
tolerates 1 replica loss; 6 replicas tolerates 2 — start with 3.

## Procedure
1. **Provision 3 hosts/VMs** (or 3 containers with `network_mode: host` —
   TB validates `--addresses` and does not accept docker-internal DNS names).
2. **Format each data file** (once, per replica):
   ```
   docker run --security-opt seccomp=unconfined -v tb0:/data \
     ghcr.io/tigerbeetle/tigerbeetle:0.16.41 \
     format --cluster=0 --replica=0 --replica-count=3 /data/0_0.tigerbeetle
   # repeat with --replica=1 /data/0_1..., --replica=2 /data/0_2...
   ```
3. **Start each replica**:
   `start --addresses=<ip0>:3000,<ip1>:3000,<ip2>:3000 /data/0_N.tigerbeetle`
   with `seccomp=unconfined` + `IPC_LOCK` (see compose service for why).
4. **Migrate data**: TB has no online node-add. Cutover path:
   - Stop accepting new transfers (maintenance flag on wallet writes).
   - Replay `wallet_transactions` from postgres into the new cluster using
     `ledgerTopUp/ledgerTollCharge/ledgerRefund` (IDs derived from refs —
     deterministic, replay-safe).
   - Verify with `reconcileBalances()` across all wallets: zero mismatches.
   - Point `TIGERBEETLE_ADDRESSES` at the 3 addresses, restart app, re-enable.
5. **Rollback**: flip env back to the single replica; postgres cache is still
   warm and correct.

## Operations
- **Health**: TCP connect per replica; TB has no HTTP probe.
- **Failure**: a dead replica restarts from its data file and catches up via
  the cluster; no intervention unless the file is lost — then reformat that
  replica and let VSR state-sync repopulate it.
- **Upgrades**: rolling, one replica at a time; check client↔cluster version
  compatibility in the TB release notes first.

## Nigerian-production notes
- Ledger durability matters more than latency here: users equate wallet
  balance with money. Prefer 3 replicas across AZs over a bigger single box.
- Keep `--cache-grid` sized so hot accounts stay in memory on modest VMs.
