/**
 * useDeviceHeartbeat — real-time WebSocket hook
 * Connects to ws://{host}/ws/devices/heartbeat and streams live device metrics.
 * Falls back to polling the REST endpoint every 5 s if WebSocket is unavailable.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { WS_BASE, deviceApi, type DeviceHeartbeat } from "@/lib/api";
import { tokenStore } from "@/lib/api";

interface HeartbeatState {
  devices: Record<string, DeviceHeartbeat>;
  connected: boolean;
  lastUpdate: Date | null;
  error: string | null;
}

export function useDeviceHeartbeat(plazaId?: string) {
  const [state, setState] = useState<HeartbeatState>({
    devices: {},
    connected: false,
    lastUpdate: null,
    error: null,
  });
  const wsRef = useRef<WebSocket | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);

  const applyHeartbeat = useCallback((hb: DeviceHeartbeat) => {
    setState(prev => ({
      ...prev,
      devices: { ...prev.devices, [hb.device_id]: hb },
      lastUpdate: new Date(),
      error: null,
    }));
  }, []);

  // Polling fallback
  const startPolling = useCallback(() => {
    if (pollRef.current) return;
    pollRef.current = setInterval(async () => {
      try {
        const list = await deviceApi.list(plazaId);
        const map: Record<string, DeviceHeartbeat> = {};
        for (const d of list) map[d.device_id] = d;
        setState(prev => ({ ...prev, devices: map, lastUpdate: new Date(), connected: false }));
      } catch {
        // silent — keep showing last known state
      }
    }, 5_000);
  }, [plazaId]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const token = tokenStore.get();
    const url = `${WS_BASE}/devices/heartbeat${plazaId ? `?plaza_id=${plazaId}` : ""}${token ? `${plazaId ? "&" : "?"}token=${token}` : ""}`;

    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttempts.current = 0;
        stopPolling();
        setState(prev => ({ ...prev, connected: true, error: null }));
      };

      ws.onmessage = (evt) => {
        try {
          const data = JSON.parse(evt.data);
          // Server may send a single heartbeat or an array (initial snapshot)
          if (Array.isArray(data)) {
            data.forEach(applyHeartbeat);
          } else {
            applyHeartbeat(data as DeviceHeartbeat);
          }
        } catch {
          // malformed message — ignore
        }
      };

      ws.onerror = () => {
        setState(prev => ({ ...prev, connected: false, error: "WebSocket error — using polling fallback" }));
        startPolling();
      };

      ws.onclose = (evt) => {
        setState(prev => ({ ...prev, connected: false }));
        if (evt.code !== 1000) {
          // Exponential back-off reconnect: 1s, 2s, 4s, 8s, max 30s
          const delay = Math.min(1000 * 2 ** reconnectAttempts.current, 30_000);
          reconnectAttempts.current++;
          reconnectRef.current = setTimeout(connect, delay);
          startPolling(); // keep data fresh while reconnecting
        }
      };
    } catch {
      // WebSocket not supported or URL invalid — fall back to polling
      setState(prev => ({ ...prev, connected: false, error: "WebSocket unavailable — using polling" }));
      startPolling();
    }
  }, [plazaId, applyHeartbeat, startPolling, stopPolling]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      stopPolling();
      wsRef.current?.close(1000, "component unmounted");
    };
  }, [connect, stopPolling]);

  const deviceList = Object.values(state.devices);

  return {
    devices: deviceList,
    deviceMap: state.devices,
    connected: state.connected,
    lastUpdate: state.lastUpdate,
    error: state.error,
    refresh: () => deviceApi.list(plazaId).then(list => {
      const map: Record<string, DeviceHeartbeat> = {};
      for (const d of list) map[d.device_id] = d;
      setState(prev => ({ ...prev, devices: map, lastUpdate: new Date() }));
    }),
  };
}
