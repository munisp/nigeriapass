/**
 * useKycStatusPush — per-application WebSocket subscription
 *
 * Connects to the server WebSocket endpoint at /ws/kyc and subscribes to
 * status events for one application reference ID:
 *
 *   Client → Server: { type: "subscribe",   referenceId }
 *   Client → Server: { type: "unsubscribe", referenceId }
 *   Server → Client: { type: "kyc_status_changed", referenceId, newStatus,
 *                      reviewNotes, kycScore, reviewedAt, reviewedBy }
 *   Server → Client: { type: "ping" }  (30 s keepalive — answered with "pong")
 *
 * There is no simulated/demo progression: when the socket cannot connect the
 * hook simply reports isConnected=false so the UI can show an honest
 * "live updates unavailable" state.
 */
import { useState, useEffect, useRef, useCallback } from "react";

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
  /** Kept for UI compatibility — always false (no polling fallback). */
  isPolling: boolean;
  lastUpdated: Date | null;
}

// ── Server event shape (mirrors server/events/kycEvents.ts) ──────────────────
type ServerStatus =
  | "submitted"
  | "under_review"
  | "approved"
  | "rejected"
  | "requires_resubmission";

interface ServerKycStatusEvent {
  type: "kyc_status_changed";
  referenceId: string;
  newStatus: ServerStatus;
  reviewNotes: string | null;
  kycScore: number | null;
  reviewedAt: number;
  reviewedBy?: string;
}

const STATUS_MAP: Record<ServerStatus, { status: KycStatus; label: string; description: string }> = {
  submitted: {
    status: "pending",
    label: "Application Submitted",
    description: "Your application has been received and is awaiting review.",
  },
  under_review: {
    status: "under_review",
    label: "Admin Review",
    description: "A compliance officer is reviewing your application.",
  },
  approved: {
    status: "approved",
    label: "KYC Approved",
    description: "Your identity has been verified. Your NigerianPass account is now active.",
  },
  rejected: {
    status: "rejected",
    label: "KYC Rejected",
    description: "Your application was rejected. See the review notes for details.",
  },
  requires_resubmission: {
    status: "rejected",
    label: "Resubmission Required",
    description: "The review team requested changes. Please resubmit with corrected details.",
  },
};

function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws/kyc`;
}

export function useKycStatusPush(applicationId: string | undefined): UseKycStatusPushReturn {
  const [latestEvent, setLatestEvent] = useState<KycStatusEvent | null>(null);
  const [history, setHistory] = useState<KycStatusEvent[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);
  const MAX_RECONNECT = 4;

  const pushEvent = useCallback((evt: KycStatusEvent) => {
    setLatestEvent(evt);
    setHistory(prev => [evt, ...prev].slice(0, 50));
    setLastUpdated(new Date());
  }, []);

  // ── WebSocket connection ──────────────────────────────────────────────────
  const connectWS = useCallback(() => {
    if (!applicationId) return;

    try {
      const ws = new WebSocket(wsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttempts.current = 0;
        setIsConnected(true);
        ws.send(JSON.stringify({ type: "subscribe", referenceId: applicationId }));
      };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data) as { type: string };
          if (msg.type === "kyc_status_changed") {
            const e = msg as unknown as ServerKycStatusEvent;
            if (e.referenceId !== applicationId) return;
            const mapped = STATUS_MAP[e.newStatus];
            if (!mapped) return;
            pushEvent({
              application_id: e.referenceId,
              status: mapped.status,
              step_label: mapped.label,
              step_description: e.reviewNotes ?? mapped.description,
              timestamp: new Date(e.reviewedAt || Date.now()).toISOString(),
              notes: e.reviewNotes ?? undefined,
              kyc_score: e.kycScore ?? undefined,
            });
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
        }
        // After MAX_RECONNECT attempts we stay disconnected — the UI shows
        // an honest "live updates unavailable" state; no fake data.
      };

      ws.onerror = () => ws.close();
    } catch {
      setIsConnected(false);
    }
  }, [applicationId, pushEvent]);

  // ── Mount / unmount ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!applicationId) return;
    connectWS();
    return () => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: "unsubscribe", referenceId: applicationId })); } catch { /* ignore */ }
      }
      ws?.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, [applicationId]); // eslint-disable-line react-hooks/exhaustive-deps

  return { latestEvent, history, isConnected, isPolling: false, lastUpdated };
}
