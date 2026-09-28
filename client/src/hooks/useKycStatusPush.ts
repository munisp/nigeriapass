/**
 * useKycStatusPush — per-application WebSocket subscription
 *
 * Connects to  ws://<host>/ws/status/<applicationId>?token=<jwt>
 * and streams live KYC/KYB status events.
 *
 * Falls back to HTTP polling every 15 s when WebSocket is unavailable.
 * In demo mode (no backend) it simulates a status progression after 8 s.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { WS_BASE, onboardingClient } from "@/lib/api";
import { tokenStore } from "@/lib/api";

export type KycStatus = "pending" | "under_review" | "approved" | "rejected";

export interface KycStatusEvent {
  application_id: string;
  status: KycStatus;
  step_label: string;
  step_description: string;
  timestamp: string;
  notes?: string;
  kyc_score?: number;
}

interface UseKycStatusPushReturn {
  latestEvent: KycStatusEvent | null;
  history: KycStatusEvent[];
  isConnected: boolean;
  isPolling: boolean;
  lastUpdated: Date | null;
}

// ── Demo simulation ───────────────────────────────────────────────────────────
const DEMO_PROGRESSION: Record<string, KycStatusEvent[]> = {
  "DRV-XKQP7": [
    {
      application_id: "DRV-XKQP7",
      status: "under_review",
      step_label: "Admin Review Started",
      step_description: "Compliance officer Adaeze Nwosu has opened your application for review.",
      timestamp: new Date().toISOString(),
      kyc_score: 87,
    },
    {
      application_id: "DRV-XKQP7",
      status: "approved",
      step_label: "KYC Approved",
      step_description: "Your identity has been verified. NigerianPass account is now active.",
      timestamp: new Date(Date.now() + 8000).toISOString(),
      notes: "All documents verified. NFC tag will be issued within 24 hours.",
      kyc_score: 91,
    },
  ],
};

export function useKycStatusPush(applicationId: string | undefined): UseKycStatusPushReturn {
  const [latestEvent, setLatestEvent] = useState<KycStatusEvent | null>(null);
  const [history, setHistory] = useState<KycStatusEvent[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isPolling, setIsPolling] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const demoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);
  const MAX_RECONNECT = 4;

  const pushEvent = useCallback((evt: KycStatusEvent) => {
    setLatestEvent(evt);
    setHistory(prev => [evt, ...prev].slice(0, 50));
    setLastUpdated(new Date());
  }, []);

  // ── HTTP poll fallback ────────────────────────────────────────────────────
  const pollStatus = useCallback(async () => {
    if (!applicationId) return;
    try {
      const res = await onboardingClient.get<KycStatusEvent>(`/applications/${applicationId}/status`);
      pushEvent(res.data);
    } catch {
      // Backend unavailable — keep existing state
    }
  }, [applicationId, pushEvent]);

  const startPolling = useCallback(() => {
    if (pollTimer.current) return;
    setIsPolling(true);
    pollStatus();
    pollTimer.current = setInterval(pollStatus, 15_000);
  }, [pollStatus]);

  // ── Demo simulation ───────────────────────────────────────────────────────
  const runDemoSimulation = useCallback(() => {
    if (!applicationId) return;
    const events = DEMO_PROGRESSION[applicationId.toUpperCase()];
    if (!events) return;

    let delay = 0;
    events.forEach(evt => {
      demoTimer.current = setTimeout(() => {
        pushEvent(evt);
      }, delay);
      delay += 8000; // 8 s between each simulated event
    });
  }, [applicationId, pushEvent]);

  // ── WebSocket connection ──────────────────────────────────────────────────
  const connectWS = useCallback(() => {
    if (!applicationId) return;
    const token = tokenStore.get();
    if (!token) {
      // Not authenticated — run demo simulation
      runDemoSimulation();
      return;
    }

    try {
      const url = `${WS_BASE}/ws/status/${applicationId}?token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttempts.current = 0;
        setIsConnected(true);
        setIsPolling(false);
        if (pollTimer.current) {
          clearInterval(pollTimer.current);
          pollTimer.current = null;
        }
      };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data) as { type: string; event?: KycStatusEvent };
          if (msg.type === "status_update" && msg.event) {
            pushEvent(msg.event);
          } else if (msg.type === "ping") {
            ws.send(JSON.stringify({ type: "pong" }));
          }
        } catch { /* ignore malformed */ }
      };

      ws.onclose = () => {
        setIsConnected(false);
        wsRef.current = null;
        if (reconnectAttempts.current < MAX_RECONNECT) {
          const delay = Math.min(1000 * 2 ** reconnectAttempts.current, 30_000);
          reconnectAttempts.current++;
          reconnectTimer.current = setTimeout(connectWS, delay);
        } else {
          // Fall back to polling + demo
          startPolling();
          runDemoSimulation();
        }
      };

      ws.onerror = () => ws.close();
    } catch {
      startPolling();
      runDemoSimulation();
    }
  }, [applicationId, pushEvent, runDemoSimulation, startPolling]);

  // ── Mount / unmount ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!applicationId) return;
    connectWS();
    return () => {
      wsRef.current?.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (pollTimer.current) clearInterval(pollTimer.current);
      if (demoTimer.current) clearTimeout(demoTimer.current);
    };
  }, [applicationId]); // eslint-disable-line react-hooks/exhaustive-deps

  return { latestEvent, history, isConnected, isPolling, lastUpdated };
}
