/**
 * NigerianPass Real-time Notification Hook
 * =========================================
 * Connects to the server WebSocket endpoint at /ws/kyc and converts server
 * events into notification entries:
 *
 *   - kyc_status_changed → KYC/KYB review notifications
 *   - wallet_credited    → wallet credit alerts
 *   - tier_upgraded      → wallet tier upgrade alerts
 *
 * Events are routed server-side to the authenticated user's userId, so this
 * hook subscribes with the current user's ID (from trpc.auth.me).
 *
 * There is no demo seed data and no polling of nonexistent REST endpoints:
 * before sign-in (or when the socket is down) the store is simply empty and
 * isConnected=false. Read state is tracked locally (server-side persistence
 * of read receipts is not yet available).
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { trpc } from "@/lib/trpc";
import { type AppNotification } from "@/lib/api";

interface NotificationState {
  notifications: AppNotification[];
  unreadCount: number;
  isConnected: boolean;
  lastUpdate: Date | null;
}

interface UseNotificationsReturn extends NotificationState {
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  refresh: () => void;
}

const MAX_RECONNECT = 5;

let notifSeq = 0;
const nextId = () => `ws-${Date.now()}-${notifSeq++}`;

function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws/kyc`;
}

export function useNotifications(): UseNotificationsReturn {
  const [state, setState] = useState<NotificationState>({
    notifications: [],
    unreadCount: 0,
    isConnected: false,
    lastUpdate: null,
  });

  // Current user — needed so the server can route user-targeted events to us
  const meQuery = trpc.auth.me.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });
  const userId = typeof meQuery.data?.id === "number" ? meQuery.data.id : null;

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);

  const pushNotification = useCallback((n: AppNotification) => {
    setState(prev => ({
      ...prev,
      notifications: [n, ...prev.notifications].slice(0, 100),
      unreadCount: prev.unreadCount + 1,
      lastUpdate: new Date(),
    }));
  }, []);

  // ── WebSocket connection ───────────────────────────────────────────────────
  const connectWS = useCallback(() => {
    if (userId === null) return; // not signed in — nothing to subscribe to

    try {
      const ws = new WebSocket(wsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttempts.current = 0;
        setState(prev => ({ ...prev, isConnected: true }));
        // Register our userId so the server routes user-targeted events here.
        // ("__self__" is a placeholder referenceId — routing is by userId.)
        ws.send(JSON.stringify({ type: "subscribe", referenceId: "__self__", userId }));
      };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data) as Record<string, unknown>;
          if (msg.type === "ping") {
            ws.send(JSON.stringify({ type: "pong" }));
            return;
          }

          if (msg.type === "kyc_status_changed") {
            const status = msg.newStatus as string;
            const referenceId = msg.referenceId as string;
            const notes = (msg.reviewNotes as string | null) ?? undefined;
            const base = { id: nextId(), read: false, reference: referenceId, created_at: new Date().toISOString() };
            if (status === "approved") {
              pushNotification({ ...base, type: "kyc_approved", title: "Application Approved", message: notes ?? `Application ${referenceId} has been approved.` });
            } else if (status === "rejected" || status === "requires_resubmission") {
              pushNotification({ ...base, type: "kyc_rejected", title: status === "rejected" ? "Application Rejected" : "Resubmission Required", message: notes ?? `Application ${referenceId} needs attention.` });
            } else {
              pushNotification({ ...base, type: "kyc_review", title: "Application Update", message: notes ?? `Application ${referenceId} is now ${status.replace(/_/g, " ")}.` });
            }
          } else if (msg.type === "wallet_credited") {
            const amount = ((msg.amountKobo as number) / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 });
            pushNotification({
              id: nextId(),
              type: "system",
              title: "Wallet Credited",
              message: `₦${amount} was credited to your wallet (ref: ${msg.reference}).`,
              read: false,
              reference: msg.reference as string,
              created_at: new Date().toISOString(),
            });
          } else if (msg.type === "tier_upgraded") {
            pushNotification({
              id: nextId(),
              type: "system",
              title: "Wallet Tier Upgraded",
              message: `Your wallet was upgraded from ${msg.oldTier} to ${msg.newTier}.`,
              read: false,
              created_at: new Date().toISOString(),
            });
          }
        } catch { /* ignore malformed */ }
      };

      ws.onclose = () => {
        setState(prev => ({ ...prev, isConnected: false }));
        wsRef.current = null;
        if (reconnectAttempts.current < MAX_RECONNECT) {
          const delay = Math.min(1000 * 2 ** reconnectAttempts.current, 30_000);
          reconnectAttempts.current++;
          reconnectTimer.current = setTimeout(connectWS, delay);
        }
        // After MAX_RECONNECT attempts, stay disconnected (honest empty state)
      };

      ws.onerror = () => {
        ws.close();
      };
    } catch {
      setState(prev => ({ ...prev, isConnected: false }));
    }
  }, [userId, pushNotification]);

  // ── Mount / unmount / re-auth ──────────────────────────────────────────────
  useEffect(() => {
    connectWS();
    return () => {
      if (wsRef.current) wsRef.current.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, [connectWS]);

  // ── Actions (local read state — no server read-receipt endpoint yet) ──────
  const markRead = useCallback(async (id: string) => {
    setState(prev => ({
      ...prev,
      notifications: prev.notifications.map(n => n.id === id ? { ...n, read: true } : n),
      unreadCount: Math.max(0, prev.unreadCount - 1),
    }));
  }, []);

  const markAllRead = useCallback(async () => {
    setState(prev => ({
      ...prev,
      notifications: prev.notifications.map(n => ({ ...n, read: true })),
      unreadCount: 0,
    }));
  }, []);

  const refresh = useCallback(() => {
    // No REST history endpoint — reconnect the socket if it dropped
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      reconnectAttempts.current = 0;
      connectWS();
    }
  }, [connectWS]);

  return { ...state, markRead, markAllRead, refresh };
}
