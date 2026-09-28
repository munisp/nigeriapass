# Runbook: payment webhook failure (Paystack / Flutterwave / Interswitch)

**Severity: high.** Missed webhooks = users paid but wallets not credited.

## Detection
- `np_payment_webhooks_total{outcome="error"}` rising (metrics.ts), or
- Provider dashboard shows failed/retrying deliveries, or
- User reports: paid, no credit; `wallet_transactions` has no row for the `externalRef`.

## Immediate triage
1. Check app health and recent deploys (`/healthz`, deploy log).
2. Verify signature secret: `PAYSTACK_SECRET_KEY` / `FLUTTERWAVE_SECRET_KEY`
   rotated? Invalid-signature rejections show as `outcome="invalid_signature"`.
3. Check DB availability — webhook handlers are DB-first; if postgres is down,
   return codes must still be 200 only AFTER durable recording.

## Replay / recovery
1. **Provider replay**: Paystack dashboard → Events → resend; Flutterwave →
   transaction → requery/repush. Handlers are idempotent on `externalRef`
   (unique partial index `uq_wtx_external_ref` — see infra/postgres/hardening.sql),
   so replays are safe.
2. **Requery fallback**: for Paystack, `GET /transaction/verify/:reference`
   with the secret key, then post through the same credit path.
3. When TigerBeetle is enabled: confirm the ledger transfer exists —
   `ledgerTopUp` derives the transfer ID from the provider reference, so a
   second attempt is an idempotent no-op (`duplicate: true`).

## Escalate when
- Any credit missing >30 min after provider confirmation → page on-call and
  reconcile against provider settlement export.
- Signature failures without a rotation → treat as spoofing attempt; capture
  source IPs, consider tightening APISIX `api-webhooks` route.

## Prevention
- Alert on `outcome="error"` rate > 1% over 5 min.
- Nightly reconciliation job: provider settlements vs wallet_transactions.
