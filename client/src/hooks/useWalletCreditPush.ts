/**
 * useWalletCreditPush — real-time wallet credit notification hook
 *
 * Connects to the existing WebSocket endpoint at /ws/kyc (the same endpoint
 * used by KYC status push) and listens for `wallet_credited` events emitted
 * by the reconciliation job when a user's wallet balance is increased.
 *
 * On receiving a credit event:
 *  - Calls onCredit(event) so the parent component can show a toast / refresh
 *  - Automatically reconnects up to 4 times with exponential back-off
 *  - Falls back silently if WebSocket is unavailable (no polling needed —
 *    the Wallet page already polls getBalance every 30 s)
 */
import { useEffect, useRef, useCallback } from "react";

export interface WalletCreditedEvent {
  type: "wallet_credited";
  userId: number;
  amountKobo: number;
  newBalanceKobo: number;
  reference: string;
  creditedAt: string;
}

export interface TierUpgradedEvent {
  type: "tier_upgraded";
  userId: number;
  oldTier: "basic" | "standard" | "premium";
  newTier: "basic" | "standard" | "premium";
  newBalanceKobo: number;
}

interface UseWalletCreditPushOptions {
  /** Called when a wallet_credited event arrives for this user */
  onCredit: (event: WalletCreditedEvent) => void;
  /** Called when a tier_upgraded event arrives for this user */
  onTierUpgrade?: (event: TierUpgradedEvent) => void;
  /** Set to false to disable the hook (e.g. when user is not authenticated) */
  enabled?: boolean;
}

const MAX_RECONNECT = 4;

export function useWalletCreditPush({
  onCredit,
  onTierUpgrade,
  enabled = true,
}: UseWalletCreditPushOptions): void {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);
  const onCreditRef = useRef(onCredit);
  const onTierUpgradeRef = useRef(onTierUpgrade);

  // Keep the callback refs up to date without triggering reconnects
  useEffect(() => {
    onCreditRef.current = onCredit;
  }, [onCredit]);

  useEffect(() => {
    onTierUpgradeRef.current = onTierUpgrade;
  }, [onTierUpgrade]);

  const connect = useCallback(() => {
    if (!enabled) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    try {
      // Derive the WebSocket base URL from the current page origin
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const url = `${proto}://${window.location.host}/ws/kyc`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttempts.current = 0;
      };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data as string) as { type: string } & WalletCreditedEvent;
          if (msg.type === "wallet_credited") {
            onCreditRef.current(msg as unknown as WalletCreditedEvent);
          } else if (msg.type === "tier_upgraded" && onTierUpgradeRef.current) {
            onTierUpgradeRef.current(msg as unknown as TierUpgradedEvent);
          } else if (msg.type === "ping") {
            ws.send(JSON.stringify({ type: "pong" }));
          }
        } catch {
          // Ignore malformed frames
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (reconnectAttempts.current < MAX_RECONNECT) {
          const delay = Math.min(1000 * 2 ** reconnectAttempts.current, 30_000);
          reconnectAttempts.current++;
          reconnectTimer.current = setTimeout(connect, delay);
        }
        // After MAX_RECONNECT failures, give up silently —
        // the Wallet page polls getBalance every 30 s as a fallback.
      };

      ws.onerror = () => ws.close();
    } catch {
      // WebSocket not supported or URL invalid — silent fallback
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    connect();
    return () => {
      wsRef.current?.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, [enabled, connect]);
}
