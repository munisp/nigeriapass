/**
 * Device Heartbeat WebSocket Server
 * ==================================
 * Manages real-time device status streaming for the Device Management dashboard.
 *
 * Protocol (Device → Server):
 *   { type: "heartbeat", device_id: "NFC-001", serial: "SN-LAG-01-01",
 *     status: "online", cpu_percent: 42, memory_percent: 61,
 *     temperature_celsius: 38, uptime_seconds: 86400,
 *     last_transaction_ms: 1234, timestamp: "2026-03-06T12:00:00Z" }
 *
 * Protocol (Browser → Server):
 *   { type: "subscribe", plaza_id?: "Lagos-Ibadan Toll" }
 *   { type: "unsubscribe" }
 *   { type: "pong" }
 *
 * Protocol (Server → Browser):
 *   { type: "connected", clientId: "..." }
 *   { type: "snapshot", devices: DeviceHeartbeat[] }   — sent on subscribe
 *   { type: "heartbeat", ...DeviceHeartbeat }           — live updates
 *   { type: "ping", serverTime: number }
 */

import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { getDb } from "./db";
import { tollDevices } from "../drizzle/schema";
import { eq } from "drizzle-orm";

export interface DeviceHeartbeat {
  device_id: string;
  serial: string;
  status: string;
  cpu_percent: number;
  memory_percent: number;
  temperature_celsius: number;
  uptime_seconds: number;
  last_transaction_ms: number;
  timestamp: string;
  plaza?: string;
}

interface BrowserClient {
  ws: WebSocket;
  plazaFilter: string | null;
  lastPing: number;
}

// In-memory cache of latest heartbeat per device
const latestHeartbeats = new Map<string, DeviceHeartbeat>();
// Browser dashboard clients
const browserClients = new Map<string, BrowserClient>();

export function setupDeviceHeartbeatServer(httpServer: Server): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws/devices/heartbeat" });

  wss.on("connection", (ws: WebSocket, req: import("http").IncomingMessage) => {
    const clientId = `dc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const url = new URL(req.url ?? "/", "http://localhost");
    const plazaFilter = url.searchParams.get("plaza_id") ?? null;

    // Determine if this is a device pushing heartbeats or a browser subscribing
    const userAgent = req.headers["user-agent"] ?? "";
    const isDevice = userAgent.includes("NigerianPass-Device") || url.searchParams.has("device");

    if (isDevice) {
      // Device connection — accept heartbeat pushes
      ws.on("message", async (data: Buffer | string) => {
        try {
          const msg = JSON.parse(data.toString()) as DeviceHeartbeat & { type?: string };
          if (msg.type === "heartbeat" || msg.device_id) {
            await handleDeviceHeartbeat(msg);
          }
        } catch {
          // ignore malformed messages
        }
      });

      ws.on("close", () => {
        console.log(`[DeviceWS] Device disconnected: ${clientId}`);
      });

      sendWs(ws, { type: "connected", role: "device", clientId });
      console.log(`[DeviceWS] Device connected: ${clientId}`);
    } else {
      // Browser dashboard client
      const client: BrowserClient = { ws, plazaFilter, lastPing: Date.now() };
      browserClients.set(clientId, client);

      // Send initial snapshot of all known devices (filtered by plaza if requested)
      const snapshot = Array.from(latestHeartbeats.values()).filter(
        (hb) => !plazaFilter || hb.plaza === plazaFilter
      );
      sendWs(ws, { type: "connected", clientId });
      sendWs(ws, { type: "snapshot", devices: snapshot });

      ws.on("message", (data: Buffer | string) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "subscribe") {
            client.plazaFilter = msg.plaza_id ?? null;
            // Re-send snapshot with new filter
            const filtered = Array.from(latestHeartbeats.values()).filter(
              (hb) => !client.plazaFilter || hb.plaza === client.plazaFilter
            );
            sendWs(ws, { type: "snapshot", devices: filtered });
          } else if (msg.type === "pong") {
            client.lastPing = Date.now();
          }
        } catch {
          // ignore
        }
      });

      ws.on("close", () => {
        browserClients.delete(clientId);
        console.log(`[DeviceWS] Browser client disconnected: ${clientId} (total: ${browserClients.size})`);
      });

      ws.on("error", () => {
        browserClients.delete(clientId);
      });

      console.log(`[DeviceWS] Browser client connected: ${clientId} (plaza: ${plazaFilter ?? "all"})`);
    }
  });

  // Keepalive ping to browser clients every 30s
  setInterval(() => {
    const now = Date.now();
    browserClients.forEach((client, id) => {
      if (client.ws.readyState === WebSocket.OPEN) {
        sendWs(client.ws, { type: "ping", serverTime: now });
        client.lastPing = now;
      } else {
        browserClients.delete(id);
      }
    });
  }, 30_000);

  console.log("[DeviceWS] Device heartbeat WebSocket server listening on /ws/devices/heartbeat");
  return wss;
}

/**
 * Process an incoming heartbeat from a device:
 * 1. Update the in-memory cache
 * 2. Persist to the DB (update status, cpu, memory, temp, uptime, lastSeen)
 * 3. Broadcast to all subscribed browser clients
 */
async function handleDeviceHeartbeat(hb: DeviceHeartbeat & { type?: string }) {
  const heartbeat: DeviceHeartbeat = {
    device_id: hb.device_id,
    serial: hb.serial ?? hb.device_id,
    status: hb.status ?? "online",
    cpu_percent: hb.cpu_percent ?? 0,
    memory_percent: hb.memory_percent ?? 0,
    temperature_celsius: hb.temperature_celsius ?? 0,
    uptime_seconds: hb.uptime_seconds ?? 0,
    last_transaction_ms: hb.last_transaction_ms ?? 0,
    timestamp: hb.timestamp ?? new Date().toISOString(),
    plaza: hb.plaza,
  };

  // Update in-memory cache
  latestHeartbeats.set(heartbeat.device_id, heartbeat);

  // Persist to DB — update the toll_devices row for this serial
  try {
    const uptimeStr = formatUptime(heartbeat.uptime_seconds);
    const database = await getDb();
    if (!database) return;
    // Map "error" to "warning" since the schema uses "warning" not "error"
    const mappedStatus = (heartbeat.status === "error" ? "warning" : heartbeat.status) as "online" | "offline" | "warning" | "maintenance";
    await database
      .update(tollDevices)
      .set({
        status: mappedStatus,
        cpu: Math.round(heartbeat.cpu_percent),
        memory: Math.round(heartbeat.memory_percent),
        temp: Math.round(heartbeat.temperature_celsius),
        uptime: uptimeStr,
        lastSeen: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(tollDevices.serial, heartbeat.serial));
  } catch (e) {
    // Non-fatal — device may not be registered yet
    console.warn(`[DeviceWS] DB update failed for serial ${heartbeat.serial}:`, e);
  }

  // Broadcast to subscribed browser clients
  broadcastHeartbeat(heartbeat);
}

function broadcastHeartbeat(hb: DeviceHeartbeat) {
  let notified = 0;
  browserClients.forEach((client) => {
    if (
      client.ws.readyState === WebSocket.OPEN &&
      (!client.plazaFilter || hb.plaza === client.plazaFilter)
    ) {
      sendWs(client.ws, { type: "heartbeat", ...hb });
      notified++;
    }
  });
  if (notified > 0) {
    console.log(`[DeviceWS] Broadcast heartbeat for ${hb.device_id} to ${notified} client(s)`);
  }
}

/**
 * Emit a heartbeat from the server side (e.g. from a tRPC procedure or cron job).
 * Useful for testing or simulating device heartbeats in development.
 */
export function emitDeviceHeartbeat(hb: DeviceHeartbeat) {
  handleDeviceHeartbeat(hb);
}

/**
 * Get the latest heartbeat snapshot for all devices (or filtered by plaza).
 */
export function getDeviceSnapshot(plazaId?: string): DeviceHeartbeat[] {
  const all = Array.from(latestHeartbeats.values());
  return plazaId ? all.filter((hb) => hb.plaza === plazaId) : all;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return `${d}d ${h}h`;
}

function sendWs(ws: WebSocket, data: Record<string, unknown>) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}
