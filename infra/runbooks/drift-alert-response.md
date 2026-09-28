# Runbook: drift alert response (ledger ↔ cached balance mismatch)

**Severity: high** — drift means a user's displayed balance (postgres cache)
disagrees with the authoritative ledger (TigerBeetle). Money truth is at stake.

## What fires this
- `reconcileBalances()` (server/integrations/tigerbeetle.ts) returns
  non-empty `mismatches` from the nightly reconciliation job, or
- A drift metric/alert on `|driftKobo| > 0` for any wallet.

## Response steps
1. **Freeze the affected wallets** from debit operations (toll charges) until
   understood. Top-ups may continue.
2. **Classify the drift**:
   - `ledgerKobo > cachedKobo`: credits landed in TB but the postgres cache
     update failed (crash between transfer and cache write). LOW harm —
     user sees less than they have.
   - `ledgerKobo < cachedKobo`: cache claims more than the ledger. HIGH harm —
     potential double-spend window; investigate before unfreezing.
3. **Trace via the deterministic IDs**: transfer IDs are derived from provider
   refs (`transfer:topup:<provider>:<ref>` etc.). `lookupTransfers` in TB vs
   `wallet_transactions.externalRef`/`tigerBeetleTransferId` in postgres shows
   exactly which leg is missing.
4. **Repair**:
   - Cache-behind: refresh `wallet_accounts.balanceKobo` from
     `ledgerBalanceKobo(userId)` — ledger wins, always.
   - Ledger-behind: identify the missed webhook/charge and replay it through
     the normal path (idempotent — replaying an existing transfer is a no-op).
5. **Root-cause before unfreeze**: the crash window between ledger write and
   cache write must be closed (transactional outbox or post-commit hook);
   otherwise drift will recur.

## Prevention
- Nightly full `reconcileBalances()`; hourly sampling of active wallets.
- Alert thresholds: ANY user-facing negative drift pages; aggregate drift
  > ₦10,000 across wallets pages regardless.
- Never "fix" the ledger to match the cache. The ledger is the truth; the
  cache is disposable.
