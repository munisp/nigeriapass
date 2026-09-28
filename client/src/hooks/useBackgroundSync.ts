/**
 * useBackgroundSync
 * =================
 * Registers Background Sync and Periodic Background Sync tags with the
 * service worker, and listens for sync completion messages from the SW.
 *
 * Supports:
 *  - One-shot sync: register "np-retry-queue" when going offline/online
 *  - Periodic sync: register "np-periodic-balance" (15 min) and
 *    "np-periodic-status" (30 min) for background data refresh
 *  - SW message listener: updates local state when SW posts SYNC_COMPLETE,
 *    BALANCE_REFRESHED, or KYC_STATUS_SYNCED messages
 */
import { useEffect, useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";

export interface SyncStatus {
  lastSyncAt: number | null;
  lastBalanceRefreshAt: number | null;
  lastKycSyncAt: number | null;
  pendingCount: number;
  isSyncing: boolean;
  periodicSyncEnabled: boolean;
  backgroundSyncSupported: boolean;
  periodicSyncSupported: boolean;
}

const SYNC_TAGS = {
  RETRY_QUEUE: "np-retry-queue",
  BALANCE: "np-balance-refresh",
  KYC: "np-kyc-status-sync",
  PERIODIC_BALANCE: "np-periodic-balance",
  PERIODIC_STATUS: "np-periodic-status",
} as const;

export function useBackgroundSync() {
  const [status, setStatus] = useState<SyncStatus>({
    lastSyncAt: null,
    lastBalanceRefreshAt: null,
    lastKycSyncAt: null,
    pendingCount: 0,
    isSyncing: false,
    periodicSyncEnabled: false,
    backgroundSyncSupported: "serviceWorker" in navigator && "SyncManager" in window,
    periodicSyncSupported: "serviceWorker" in navigator && "PeriodicSyncManager" in window,
  });

  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const pingQuery = trpc.sync.ping.useQuery(undefined, { enabled: false });

  // ── Get SW registration ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.ready.then(reg => {
      registrationRef.current = reg;
    });
  }, []);

  // ── Listen for SW messages ──────────────────────────────────────────────────
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    const handleMessage = (event: MessageEvent) => {
      const { type, processed, timestamp } = event.data || {};

      switch (type) {
        case "SYNC_COMPLETE":
          setStatus(prev => ({
            ...prev,
            lastSyncAt: timestamp,
            isSyncing: false,
            pendingCount: Math.max(0, prev.pendingCount - (processed ?? 0)),
          }));
          if (processed > 0) {
            toast.success(`${processed} offline action${processed > 1 ? "s" : ""} synced successfully`, {
              description: "Your queued requests have been sent to the server.",
            });
          }
          break;

        case "BALANCE_REFRESHED":
          setStatus(prev => ({ ...prev, lastBalanceRefreshAt: timestamp }));
          break;

        case "KYC_STATUS_SYNCED":
          setStatus(prev => ({ ...prev, lastKycSyncAt: timestamp }));
          break;
      }
    };

    navigator.serviceWorker.addEventListener("message", handleMessage);
    return () => navigator.serviceWorker.removeEventListener("message", handleMessage);
  }, []);

  // ── Register one-shot sync when coming back online ──────────────────────────
  useEffect(() => {
    const handleOnline = async () => {
      await registerSync(SYNC_TAGS.RETRY_QUEUE);
      await registerSync(SYNC_TAGS.BALANCE);
    };

    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, []);

  // ── Register a Background Sync tag ─────────────────────────────────────────
  const registerSync = useCallback(async (tag: string): Promise<boolean> => {
    const reg = registrationRef.current;
    if (!reg) return false;

    try {
      if ("sync" in reg) {
        await (reg as any).sync.register(tag);
        return true;
      }
      return false;
    } catch (err) {
      console.warn(`[BackgroundSync] Failed to register sync tag "${tag}":`, err);
      return false;
    }
  }, []);

  // ── Enable periodic background sync ────────────────────────────────────────
  const enablePeriodicSync = useCallback(async (): Promise<boolean> => {
    const reg = registrationRef.current;
    if (!reg || !("periodicSync" in reg)) return false;

    try {
      // Request permission first
      const status = await (navigator as any).permissions?.query?.({
        name: "periodic-background-sync",
      });

      if (status?.state === "denied") {
        toast.error("Periodic sync permission denied. Enable it in browser settings.");
        return false;
      }

      const periodicSync = (reg as any).periodicSync;

      // Register balance refresh every 15 minutes
      await periodicSync.register(SYNC_TAGS.PERIODIC_BALANCE, {
        minInterval: 15 * 60 * 1000,
      });

      // Register KYC status sync every 30 minutes
      await periodicSync.register(SYNC_TAGS.PERIODIC_STATUS, {
        minInterval: 30 * 60 * 1000,
      });

      setStatus(prev => ({ ...prev, periodicSyncEnabled: true }));

      // Notify the server that this user has enabled periodic sync
      await pingQuery.refetch();

      toast.success("Periodic background sync enabled", {
        description: "Balance and status will refresh every 15–30 minutes, even when the app is closed.",
      });

      return true;
    } catch (err) {
      console.warn("[BackgroundSync] Failed to enable periodic sync:", err);
      return false;
    }
  }, [pingQuery]);

  // ── Disable periodic background sync ───────────────────────────────────────
  const disablePeriodicSync = useCallback(async (): Promise<void> => {
    const reg = registrationRef.current;
    if (!reg || !("periodicSync" in reg)) return;

    try {
      const periodicSync = (reg as any).periodicSync;
      await periodicSync.unregister(SYNC_TAGS.PERIODIC_BALANCE);
      await periodicSync.unregister(SYNC_TAGS.PERIODIC_STATUS);
      setStatus(prev => ({ ...prev, periodicSyncEnabled: false }));
      toast.info("Periodic background sync disabled");
    } catch (err) {
      console.warn("[BackgroundSync] Failed to disable periodic sync:", err);
    }
  }, []);

  // ── Manual trigger: force retry queue flush ─────────────────────────────────
  const triggerRetryQueue = useCallback(async () => {
    setStatus(prev => ({ ...prev, isSyncing: true }));
    const registered = await registerSync(SYNC_TAGS.RETRY_QUEUE);
    if (!registered) {
      // Fallback: trigger via tRPC directly if SW sync not available
      setStatus(prev => ({ ...prev, isSyncing: false }));
    }
  }, [registerSync]);

  // ── Manual trigger: force balance refresh ──────────────────────────────────
  const triggerBalanceRefresh = useCallback(async () => {
    const registered = await registerSync(SYNC_TAGS.BALANCE);
    if (!registered) {
      // Fallback: the Wallet page will refetch on its own
    }
  }, [registerSync]);

  // ── Check which periodic sync tags are currently registered ────────────────
  const getRegisteredTags = useCallback(async (): Promise<string[]> => {
    const reg = registrationRef.current;
    if (!reg || !("periodicSync" in reg)) return [];
    try {
      return await (reg as any).periodicSync.getTags();
    } catch {
      return [];
    }
  }, []);

  return {
    status,
    registerSync,
    enablePeriodicSync,
    disablePeriodicSync,
    triggerRetryQueue,
    triggerBalanceRefresh,
    getRegisteredTags,
    SYNC_TAGS,
  };
}
