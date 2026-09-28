/**
 * WebSocket Server
 * ================
 * Manages real-time connections from browser clients.
 * Clients subscribe to KYC status updates for specific application reference IDs.
 *
 * Protocol:
 *   Client → Server: { type: "subscribe", referenceId: "DRV-XKQP7" }
 *   Client → Server: { type: "unsubscribe", referenceId: "DRV-XKQP7" }
 *   Server → Client: { type: "kyc_status_changed", ...KycStatusChangedEvent }
 *   Server → Client: { type: "ping" }  (every 30s keepalive)
 *
 * The admin router emits "status_changed" on the kycStatusEmitter when an
 * admin approves or rejects an application. This module listens for those
 * events and forwards them to the relevant connected clients.
 */
import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { getKycStatusEmitter, type KycStatusChangedEvent, type WalletCreditedEvent, type TierUpgradedEvent } from "./events/kycEvents";
import { notifyOwner } from "./_core/notification";
import { sdk } from "./_core/sdk";

interface ConnectedClient {
  ws: WebSocket;
  userId: number | null;
  /** Set of referenceIds this client is subscribed to */
  subscriptions: Set<string>;
  lastPing: number;
}

const clients = new Map<string, ConnectedClient>();
let pingInterval: ReturnType<typeof setInterval> | null = null;

export function setupWebSocketServer(httpServer: Server): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws/kyc" });

  // Forward KYC status events to subscribed clients
  const emitter = getKycStatusEmitter();
  emitter.on("status_changed", (event: KycStatusChangedEvent) => {
    broadcastStatusChange(event);
  });

  // Forward tier_upgraded events to the user's connected browser tab
  emitter.on("tier_upgraded", (event: TierUpgradedEvent) => {
    broadcastTierUpgraded(event);
  });

  // Forward wallet_credited events to the user's connected browser tab
  emitter.on("wallet_credited", (event: WalletCreditedEvent) => {
    broadcastWalletCredited(event);
    // Also send an owner notification so the platform admin is aware
    const amountNaira = (event.amountKobo / 100).toLocaleString("en-NG", {
      style: "currency", currency: "NGN", minimumFractionDigits: 2,
    });
    notifyOwner({
      title: "Wallet Credited via Reconciliation",
      content: `User ${event.userId} wallet credited ${amountNaira} (ref: ${event.reference}, provider: ${event.provider})`,
    }).catch(e => console.warn("[WS] Failed to notify owner of wallet credit:", e));
  });

  wss.on("connection", async (ws: WebSocket, req: import("http").IncomingMessage) => {
    const clientId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // ── Authenticate the upgrade request (audit v13, P0-9) ──────────────────
    // The session JWT cookie is validated server-side; userId is derived from
    // the authenticated user — client-supplied userId claims are ignored.
    let authedUserId: number | null = null;
    try {
      const user = await sdk.authenticateRequest(req as unknown as import("express").Request);
      authedUserId = user.id;
    } catch {
      // Unauthenticated sockets may still subscribe to referenceId channels
      // (public status page) but NEVER receive user-targeted events.
      authedUserId = null;
    }

    const client: ConnectedClient = {
      ws,
      userId: authedUserId,
      subscriptions: new Set(),
      lastPing: Date.now(),
    };
    clients.set(clientId, client);

    console.log(`[WS] Client connected: ${clientId} (total: ${clients.size})`);

    ws.on("message", (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString());
        handleClientMessage(clientId, client, msg);
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on("close", () => {
      clients.delete(clientId);
      console.log(`[WS] Client disconnected: ${clientId} (total: ${clients.size})`);
    });

    ws.on("error", (err: Error) => {
      console.error(`[WS] Client error ${clientId}:`, err.message);
      clients.delete(clientId);
    });

    // Send welcome message
    sendToClient(ws, { type: "connected", clientId });
  });

  // Keepalive ping every 30 seconds
  pingInterval = setInterval(() => {
    const now = Date.now();
    clients.forEach((client, id) => {
      if (client.ws.readyState === WebSocket.OPEN) {
        sendToClient(client.ws, { type: "ping", serverTime: now });
        client.lastPing = now;
      } else {
        clients.delete(id);
      }
    });
  }, 30_000);

  console.log("[WS] WebSocket server listening on /ws/kyc");
  return wss;
}

function handleClientMessage(
  clientId: string,
  client: ConnectedClient,
  msg: Record<string, unknown>
) {
  switch (msg.type) {
    case "subscribe": {
      const refId = msg.referenceId as string;
      if (refId) {
        client.subscriptions.add(refId);
        // NOTE: userId is set ONLY from the authenticated session at upgrade
        // time (P0-9) — client-supplied userId values are never trusted.
        sendToClient(client.ws, { type: "subscribed", referenceId: refId, authenticated: client.userId !== null });
        console.log(`[WS] ${clientId} subscribed to ${refId}`);
      }
      break;
    }
    case "unsubscribe": {
      const refId = msg.referenceId as string;
      if (refId) {
        client.subscriptions.delete(refId);
        sendToClient(client.ws, { type: "unsubscribed", referenceId: refId });
      }
      break;
    }
    case "pong": {
      client.lastPing = Date.now();
      break;
    }
  }
}

function broadcastTierUpgraded(event: TierUpgradedEvent) {
  let notified = 0;
  clients.forEach((client) => {
    if (
      client.ws.readyState === WebSocket.OPEN &&
      client.userId === event.userId
    ) {
      sendToClient(client.ws, { type: "tier_upgraded", ...event });
      notified++;
    }
  });
  console.log(`[WS] Broadcast tier_upgraded for user ${event.userId} (${event.oldTier} → ${event.newTier}) to ${notified} client(s)`);
}

function broadcastWalletCredited(event: WalletCreditedEvent) {
  let notified = 0;
  clients.forEach((client) => {
    if (
      client.ws.readyState === WebSocket.OPEN &&
      client.userId === event.userId
    ) {
      sendToClient(client.ws, { type: "wallet_credited", ...event });
      notified++;
    }
  });
  console.log(`[WS] Broadcast wallet_credited for user ${event.userId} to ${notified} client(s)`);
}

function broadcastStatusChange(event: KycStatusChangedEvent) {
  let notified = 0;
  clients.forEach((client) => {
    if (
      client.ws.readyState === WebSocket.OPEN &&
      (client.subscriptions.has(event.referenceId) ||
        (event.userId !== null && client.userId === event.userId))
    ) {
      sendToClient(client.ws, { type: "kyc_status_changed", ...event });
      notified++;
    }
  });
  console.log(`[WS] Broadcast status_changed for ${event.referenceId} to ${notified} client(s)`);
}

function sendToClient(ws: WebSocket, data: Record<string, unknown>) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

export function getConnectedClientCount(): number {
  return clients.size;
}
