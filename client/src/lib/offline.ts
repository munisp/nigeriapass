/**
 * NigerianPass Offline Infrastructure
 * =====================================
 * Designed for Nigerian network realities:
 *  - 2G/EDGE (50–200 kbps) is the dominant mobile tier outside Lagos/Abuja
 *  - NEPA power outages mean devices lose charge mid-session
 *  - Intermittent connectivity — users may go offline mid-form
 *  - Low-end Android devices with limited RAM (512 MB – 2 GB)
 *
 * Architecture:
 *  1. NetworkMonitor   — detects online/offline, connection type, effective speed
 *  2. OfflineDB        — IndexedDB wrapper for form drafts, queued requests, cached data
 *  3. RetryQueue       — persists failed API calls and replays them on reconnect
 *  4. BatteryMonitor   — reduces polling/animation when battery < 20%
 *  5. DataSaver        — respects Save-Data header / connection type to skip heavy assets
 */

// ── 1. Network Monitor ────────────────────────────────────────────────────────

export type ConnectionType = "4g" | "3g" | "2g" | "slow-2g" | "wifi" | "ethernet" | "unknown" | "offline";

export interface NetworkState {
  online: boolean;
  type: ConnectionType;
  effectiveType: ConnectionType;
  downlink: number;       // Mbps
  rtt: number;            // ms
  saveData: boolean;
  isSlowConnection: boolean;  // true for 2g/slow-2g/rtt>500
}

function getConnectionInfo(): Omit<NetworkState, "online"> {
  const nav = navigator as any;
  const conn = nav.connection || nav.mozConnection || nav.webkitConnection;

  if (!conn) {
    return {
      type: "unknown",
      effectiveType: "unknown",
      downlink: 10,
      rtt: 100,
      saveData: false,
      isSlowConnection: false,
    };
  }

  const effectiveType: ConnectionType = conn.effectiveType || "unknown";
  const isSlowConnection = effectiveType === "2g" || effectiveType === "slow-2g" || (conn.rtt ?? 0) > 500;

  return {
    type: conn.type || "unknown",
    effectiveType,
    downlink: conn.downlink ?? 10,
    rtt: conn.rtt ?? 100,
    saveData: conn.saveData ?? false,
    isSlowConnection,
  };
}

export function getNetworkState(): NetworkState {
  return {
    online: navigator.onLine,
    ...getConnectionInfo(),
  };
}

type NetworkListener = (state: NetworkState) => void;
const networkListeners = new Set<NetworkListener>();

function notifyNetworkListeners() {
  const state = getNetworkState();
  networkListeners.forEach(fn => fn(state));
}

window.addEventListener("online", notifyNetworkListeners);
window.addEventListener("offline", notifyNetworkListeners);

const nav = navigator as any;
const conn = nav.connection || nav.mozConnection || nav.webkitConnection;
if (conn) conn.addEventListener("change", notifyNetworkListeners);

export function onNetworkChange(fn: NetworkListener): () => void {
  networkListeners.add(fn);
  return () => networkListeners.delete(fn);
}

// ── 2. IndexedDB Wrapper ──────────────────────────────────────────────────────

const DB_NAME = "nigerianpass_offline";
const DB_VERSION = 2;

const STORES = {
  FORM_DRAFTS: "form_drafts",       // KYC/KYB form progress
  RETRY_QUEUE: "retry_queue",       // Failed API requests to replay
  CACHED_DATA: "cached_data",       // API responses (status, wallet balance)
  MEDIA_QUEUE: "media_queue",       // Photos/docs waiting to upload
} as const;

let _db: IDBDatabase | null = null;

export async function openDB(): Promise<IDBDatabase> {
  if (_db) return _db;

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;

      // Form drafts — keyed by formId (e.g. "driver-kyc", "vehicle-reg")
      if (!db.objectStoreNames.contains(STORES.FORM_DRAFTS)) {
        const store = db.createObjectStore(STORES.FORM_DRAFTS, { keyPath: "formId" });
        store.createIndex("updatedAt", "updatedAt");
      }

      // Retry queue — auto-increment id
      if (!db.objectStoreNames.contains(STORES.RETRY_QUEUE)) {
        const store = db.createObjectStore(STORES.RETRY_QUEUE, { keyPath: "id", autoIncrement: true });
        store.createIndex("createdAt", "createdAt");
        store.createIndex("status", "status");
      }

      // Cached API data — keyed by cacheKey
      if (!db.objectStoreNames.contains(STORES.CACHED_DATA)) {
        const store = db.createObjectStore(STORES.CACHED_DATA, { keyPath: "cacheKey" });
        store.createIndex("expiresAt", "expiresAt");
      }

      // Media upload queue
      if (!db.objectStoreNames.contains(STORES.MEDIA_QUEUE)) {
        const store = db.createObjectStore(STORES.MEDIA_QUEUE, { keyPath: "id", autoIncrement: true });
        store.createIndex("formId", "formId");
        store.createIndex("status", "status");
      }
    };

    req.onsuccess = () => {
      _db = req.result;
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ── 3. Form Draft API ─────────────────────────────────────────────────────────

export interface FormDraft {
  formId: string;
  data: Record<string, unknown>;
  step: number;
  updatedAt: number;
  version: number;
}

export async function saveDraft(formId: string, data: Record<string, unknown>, step = 0): Promise<void> {
  const existing = await getDraft(formId);
  const draft: FormDraft = {
    formId,
    data,
    step,
    updatedAt: Date.now(),
    version: (existing?.version ?? 0) + 1,
  };
  await tx(STORES.FORM_DRAFTS, "readwrite", store => store.put(draft));
}

export async function getDraft(formId: string): Promise<FormDraft | null> {
  try {
    const result = await tx<FormDraft | undefined>(STORES.FORM_DRAFTS, "readonly", store => store.get(formId));
    return result ?? null;
  } catch {
    return null;
  }
}

export async function deleteDraft(formId: string): Promise<void> {
  await tx(STORES.FORM_DRAFTS, "readwrite", store => store.delete(formId));
}

export async function getAllDrafts(): Promise<FormDraft[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORES.FORM_DRAFTS, "readonly");
    const store = transaction.objectStore(STORES.FORM_DRAFTS);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ── 4. Retry Queue API ────────────────────────────────────────────────────────

export interface RetryItem {
  id?: number;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  createdAt: number;
  attempts: number;
  maxAttempts: number;
  status: "pending" | "processing" | "failed";
  label: string;  // Human-readable description, e.g. "Submit Driver KYC"
}

export async function enqueueRetry(item: Omit<RetryItem, "id" | "createdAt" | "attempts" | "status">): Promise<void> {
  const entry: Omit<RetryItem, "id"> = {
    ...item,
    createdAt: Date.now(),
    attempts: 0,
    status: "pending",
  };
  await tx(STORES.RETRY_QUEUE, "readwrite", store => store.add(entry));
}

export async function getPendingRetries(): Promise<RetryItem[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORES.RETRY_QUEUE, "readonly");
    const store = transaction.objectStore(STORES.RETRY_QUEUE);
    const index = store.index("status");
    const req = index.getAll("pending");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function updateRetryItem(id: number, updates: Partial<RetryItem>): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORES.RETRY_QUEUE, "readwrite");
    const store = transaction.objectStore(STORES.RETRY_QUEUE);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const item = { ...getReq.result, ...updates };
      const putReq = store.put(item);
      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

export async function deleteRetryItem(id: number): Promise<void> {
  await tx(STORES.RETRY_QUEUE, "readwrite", store => store.delete(id));
}

// ── 5. Cached Data API ────────────────────────────────────────────────────────

interface CacheEntry<T> {
  cacheKey: string;
  data: T;
  cachedAt: number;
  expiresAt: number;
}

export async function setCachedData<T>(cacheKey: string, data: T, ttlMs = 5 * 60 * 1000): Promise<void> {
  const entry: CacheEntry<T> = {
    cacheKey,
    data,
    cachedAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
  };
  await tx(STORES.CACHED_DATA, "readwrite", store => store.put(entry));
}

export async function getCachedData<T>(cacheKey: string): Promise<T | null> {
  try {
    const entry = await tx<CacheEntry<T> | undefined>(STORES.CACHED_DATA, "readonly", store => store.get(cacheKey));
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) return null;
    return entry.data;
  } catch {
    return null;
  }
}

export async function getCachedDataStale<T>(cacheKey: string): Promise<T | null> {
  // Returns stale data even if expired — useful for offline fallback
  try {
    const entry = await tx<CacheEntry<T> | undefined>(STORES.CACHED_DATA, "readonly", store => store.get(cacheKey));
    return entry?.data ?? null;
  } catch {
    return null;
  }
}

// ── 6. Retry Queue Processor ──────────────────────────────────────────────────

let retryProcessorRunning = false;

export async function processRetryQueue(): Promise<{ processed: number; failed: number }> {
  if (retryProcessorRunning || !navigator.onLine) return { processed: 0, failed: 0 };
  retryProcessorRunning = true;

  let processed = 0;
  let failed = 0;

  try {
    const items = await getPendingRetries();
    for (const item of items) {
      if (!item.id) continue;
      await updateRetryItem(item.id, { status: "processing", attempts: item.attempts + 1 });

      try {
        const response = await fetch(item.url, {
          method: item.method,
          headers: item.headers,
          body: item.body,
          signal: AbortSignal.timeout(15_000),
        });

        if (response.ok) {
          await deleteRetryItem(item.id);
          processed++;
        } else if (response.status >= 400 && response.status < 500) {
          // Client error — don't retry
          await updateRetryItem(item.id, { status: "failed" });
          failed++;
        } else {
          // Server error — reset to pending for next attempt
          await updateRetryItem(item.id, { status: "pending" });
        }
      } catch {
        if (item.attempts >= item.maxAttempts) {
          await updateRetryItem(item.id, { status: "failed" });
          failed++;
        } else {
          await updateRetryItem(item.id, { status: "pending" });
        }
      }
    }
  } finally {
    retryProcessorRunning = false;
  }

  return { processed, failed };
}

// Auto-process queue when coming back online
window.addEventListener("online", () => {
  setTimeout(() => processRetryQueue(), 1500); // slight delay for connection to stabilise
});

// ── 7. Battery Monitor ────────────────────────────────────────────────────────

export interface BatteryState {
  level: number;       // 0–1
  charging: boolean;
  isLow: boolean;      // < 20%
  isCritical: boolean; // < 10%
}

export async function getBatteryState(): Promise<BatteryState> {
  try {
    const battery = await (navigator as any).getBattery?.();
    if (!battery) return { level: 1, charging: true, isLow: false, isCritical: false };
    return {
      level: battery.level,
      charging: battery.charging,
      isLow: battery.level < 0.2,
      isCritical: battery.level < 0.1,
    };
  } catch {
    return { level: 1, charging: true, isLow: false, isCritical: false };
  }
}

// ── 8. Offline-aware fetch wrapper ────────────────────────────────────────────

export interface OfflineFetchOptions {
  cacheKey?: string;
  cacheTtlMs?: number;
  retryLabel?: string;
  maxRetries?: number;
  timeout?: number;
}

export async function offlineFetch<T>(
  url: string,
  init: RequestInit = {},
  options: OfflineFetchOptions = {}
): Promise<T> {
  const {
    cacheKey,
    cacheTtlMs = 5 * 60 * 1000,
    retryLabel = "API Request",
    maxRetries = 5,
    timeout = 20_000,
  } = options;

  // If offline and we have a cache key, return stale data
  if (!navigator.onLine && cacheKey) {
    const stale = await getCachedDataStale<T>(cacheKey);
    if (stale !== null) return stale;
    throw new Error("OFFLINE_NO_CACHE");
  }

  // If offline and it's a mutation, queue it
  if (!navigator.onLine && init.method && init.method !== "GET") {
    await enqueueRetry({
      url,
      method: init.method,
      headers: (init.headers as Record<string, string>) ?? {},
      body: init.body ? String(init.body) : null,
      label: retryLabel,
      maxAttempts: maxRetries,
    });
    throw new Error("QUEUED_FOR_RETRY");
  }

  // Check fresh cache first for GET requests
  if ((!init.method || init.method === "GET") && cacheKey) {
    const cached = await getCachedData<T>(cacheKey);
    if (cached !== null) return cached;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data: T = await response.json();

    // Cache successful GET responses
    if ((!init.method || init.method === "GET") && cacheKey) {
      await setCachedData(cacheKey, data, cacheTtlMs);
    }

    return data;
  } catch (err: unknown) {
    const error = err as Error;
    // Network failure — queue mutation or return stale cache
    if (error.name === "AbortError" || error.message.includes("fetch")) {
      if (init.method && init.method !== "GET") {
        await enqueueRetry({
          url,
          method: init.method,
          headers: (init.headers as Record<string, string>) ?? {},
          body: init.body ? String(init.body) : null,
          label: retryLabel,
          maxAttempts: maxRetries,
        });
        throw new Error("QUEUED_FOR_RETRY");
      }
      if (cacheKey) {
        const stale = await getCachedDataStale<T>(cacheKey);
        if (stale !== null) return stale;
      }
    }
    throw err;
  }
}

// ── 9. Storage quota check ────────────────────────────────────────────────────

export async function getStorageQuota(): Promise<{ used: number; quota: number; percentUsed: number }> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (!estimate) return { used: 0, quota: 0, percentUsed: 0 };
    const used = estimate.usage ?? 0;
    const quota = estimate.quota ?? 0;
    return { used, quota, percentUsed: quota > 0 ? Math.round((used / quota) * 100) : 0 };
  } catch {
    return { used: 0, quota: 0, percentUsed: 0 };
  }
}

// Request persistent storage (prevents browser from evicting our data)
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (navigator.storage?.persist) {
      return await navigator.storage.persist();
    }
    return false;
  } catch {
    return false;
  }
}
