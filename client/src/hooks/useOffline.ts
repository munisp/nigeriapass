/**
 * useOffline
 *
 * Provides real-time network state, battery status, pending retry count,
 * and storage quota to any component. Designed for Nigerian low-connectivity UX.
 */
import { useState, useEffect, useCallback } from "react";
import {
  getNetworkState, onNetworkChange, NetworkState,
  getBatteryState, BatteryState,
  getPendingRetries, processRetryQueue,
  getStorageQuota, requestPersistentStorage,
} from "@/lib/offline";

export interface OfflineState {
  network: NetworkState;
  battery: BatteryState;
  pendingRetries: number;
  storageUsedPct: number;
  isPersistentStorage: boolean;
  isSlowOrOffline: boolean;
  processQueue: () => Promise<void>;
}

const DEFAULT_BATTERY: BatteryState = { level: 1, charging: true, isLow: false, isCritical: false };

export function useOffline(): OfflineState {
  const [network, setNetwork] = useState<NetworkState>(getNetworkState);
  const [battery, setBattery] = useState<BatteryState>(DEFAULT_BATTERY);
  const [pendingRetries, setPendingRetries] = useState(0);
  const [storageUsedPct, setStorageUsedPct] = useState(0);
  const [isPersistentStorage, setIsPersistentStorage] = useState(false);

  // Network changes
  useEffect(() => {
    const unsub = onNetworkChange(setNetwork);
    return unsub;
  }, []);

  // Battery
  useEffect(() => {
    getBatteryState().then(setBattery);
    // Re-check every 60 seconds
    const interval = setInterval(() => getBatteryState().then(setBattery), 60_000);
    return () => clearInterval(interval);
  }, []);

  // Retry queue count
  useEffect(() => {
    const refresh = async () => {
      const items = await getPendingRetries();
      setPendingRetries(items.length);
    };
    refresh();
    const interval = setInterval(refresh, 10_000);
    return () => clearInterval(interval);
  }, []);

  // Storage quota
  useEffect(() => {
    getStorageQuota().then(q => setStorageUsedPct(q.percentUsed));
    requestPersistentStorage().then(setIsPersistentStorage);
  }, []);

  const processQueue = useCallback(async () => {
    await processRetryQueue();
    const items = await getPendingRetries();
    setPendingRetries(items.length);
  }, []);

  return {
    network,
    battery,
    pendingRetries,
    storageUsedPct,
    isPersistentStorage,
    isSlowOrOffline: !network.online || network.isSlowConnection,
    processQueue,
  };
}
