/**
 * NigerianPass Real-time Notification Hook
 * Connects to the WebSocket notifications stream and maintains a local notification store.
 * Falls back to polling every 30s if WebSocket is unavailable.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { notificationApi, type AppNotification, WS_BASE } from "@/lib/api";
import { tokenStore } from "@/lib/api";

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

// Simulate demo notifications when no backend is available
const DEMO_NOTIFICATIONS: AppNotification[] = [
  {
    id: "n1",
    type: "kyc_review",
    title: "KYC Under Review",
    message: "Your driver KYC application DRV-XKQP7 is being reviewed by our team.",
    read: false,
    reference: "DRV-XKQP7",
    created_at: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
  },
  {
    id: "n2",
    type: "vehicle_approved",
    title: "Vehicle Registered",
    message: "Vehicle ABC-123-XY has been successfully registered and is toll-ready.",
    read: false,
    reference: "VEH-M3NR2",
    created_at: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
  },
  {
    id: "n3",
    type: "toll_charge",
    title: "Toll Charged",
    message: "₦350 deducted at Lagos-Ibadan Expressway (Sagamu Interchange). Balance: ₦4,650.",
    read: true,
    reference: "TXN-8823",
    created_at: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(),
  },
  {
    id: "n4",
    type: "low_balance",
    title: "Low Wallet Balance",
    message: "Your NigerianPass wallet balance is below ₦1,000. Top up to avoid disruption.",
    read: true,
    created_at: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(),
  },
  {
    id: "n5",
    type: "kyc_approved",
    title: "KYC Approved",
    message: "Congratulations! Your identity has been verified. You can now register vehicles.",
    read: true,
    reference: "DRV-PREV1",
    created_at: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
  },
];

export function useNotifications(): UseNotificationsReturn {
  const [state, setState] = useState<NotificationState>({
    notifications: DEMO_NOTIFICATIONS,
    unreadCount: DEMO_NOTIFICATIONS.filter(n => !n.read).length,
    isConnected: false,
    lastUpdate: null,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectAttempts = useRef(0);
  const MAX_RECONNECT = 5;

  // ── Fetch from API (polling fallback) ──────────────────────────────────────
  const fetchNotifications = useCallback(async () => {
    const token = tokenStore.get();
    if (!token) return; // not authenticated
    try {
      const data = await notificationApi.list({ limit: 50 });
      setState(prev => ({
        ...prev,
        notifications: data.notifications,
        unreadCount: data.unread_count,
        lastUpdate: new Date(),
      }));
    } catch {
      // Backend unavailable — keep demo data
    }
  }, []);

  // ── WebSocket connection ───────────────────────────────────────────────────
  const connectWS = useCallback(() => {
    const token = tokenStore.get();
    if (!token) return;

    try {
      const url = `${WS_BASE}/notifications?token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttempts.current = 0;
        setState(prev => ({ ...prev, isConnected: true }));
        // Stop polling once WS is connected
        if (pollTimer.current) {
          clearInterval(pollTimer.current);
          pollTimer.current = null;
        }
      };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data) as { type: string; notification?: AppNotification; unread_count?: number };
          if (msg.type === "notification" && msg.notification) {
            setState(prev => ({
              ...prev,
              notifications: [msg.notification!, ...prev.notifications].slice(0, 100),
              unreadCount: msg.unread_count ?? prev.unreadCount + 1,
              lastUpdate: new Date(),
            }));
          } else if (msg.type === "ping") {
            ws.send(JSON.stringify({ type: "pong" }));
          }
        } catch { /* ignore malformed */ }
      };

      ws.onclose = () => {
        setState(prev => ({ ...prev, isConnected: false }));
        wsRef.current = null;
        // Exponential back-off reconnect
        if (reconnectAttempts.current < MAX_RECONNECT) {
          const delay = Math.min(1000 * 2 ** reconnectAttempts.current, 30_000);
          reconnectAttempts.current++;
          reconnectTimer.current = setTimeout(connectWS, delay);
        } else {
          // Fall back to polling
          startPolling();
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    } catch {
      startPolling();
    }
  }, [fetchNotifications]); // eslint-disable-line react-hooks/exhaustive-deps

  const startPolling = useCallback(() => {
    if (pollTimer.current) return;
    fetchNotifications();
    pollTimer.current = setInterval(fetchNotifications, 30_000);
  }, [fetchNotifications]);

  // ── Mount / unmount ────────────────────────────────────────────────────────
  useEffect(() => {
    connectWS();
    return () => {
      if (wsRef.current) wsRef.current.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Actions ────────────────────────────────────────────────────────────────
  const markRead = useCallback(async (id: string) => {
    setState(prev => ({
      ...prev,
      notifications: prev.notifications.map(n => n.id === id ? { ...n, read: true } : n),
      unreadCount: Math.max(0, prev.unreadCount - 1),
    }));
    try { await notificationApi.markRead(id); } catch { /* optimistic update — ignore */ }
  }, []);

  const markAllRead = useCallback(async () => {
    setState(prev => ({
      ...prev,
      notifications: prev.notifications.map(n => ({ ...n, read: true })),
      unreadCount: 0,
    }));
    try { await notificationApi.markAllRead(); } catch { /* optimistic update — ignore */ }
  }, []);

  const refresh = useCallback(() => {
    fetchNotifications();
  }, [fetchNotifications]);

  return { ...state, markRead, markAllRead, refresh };
}
