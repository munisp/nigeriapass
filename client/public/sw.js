/**
 * NigerianPass Service Worker
 * ─────────────────────────────────────────────────────────────────────────────
 * Caching strategy:
 *  - Precache: app shell ("/", /offline.html, /manifest.json, icons)
 *  - Static assets (hashed /assets/*): stale-while-revalidate
 *  - /api/trpc GET (queries): network-first with 30s cache fallback (TTL 60s)
 *  - Mutations / webhooks (/api/payments, /api/ussd, POST): network-only
 *  - Navigations: network-first, offline fallback to cached shell/offline.html
 *
 * Cache versioning: bump CACHE_VERSION on every deploy that changes the
 * precache list or strategy. activate() deletes all caches from older
 * versions.
 *
 * Background sync tags (kept compatible with existing client sync code):
 *  - "np-retry-queue"     → replay IndexedDB retry_queue mutations
 *  - "np-balance-refresh" → refresh wallet balance, postMessage BALANCE_REFRESHED
 *  - "np-kyc-status-sync" → refresh KYC statuses, postMessage KYC_STATUS_SYNCED
 *  - periodic: "np-periodic-balance", "np-periodic-status"
 */

const CACHE_VERSION = "v2";
const PRECACHE = `np-precache-${CACHE_VERSION}`;
const RUNTIME_STATIC = `np-static-${CACHE_VERSION}`;
const RUNTIME_API = `np-api-${CACHE_VERSION}`;
const ACTIVE_CACHES = [PRECACHE, RUNTIME_STATIC, RUNTIME_API];

const OFFLINE_URL = "/offline.html";
/** TTL for cached /api/trpc GET responses (ms). */
const API_CACHE_TTL_MS = 60 * 1000;
/** Network timeout before falling back to cache for API GETs (ms). */
const API_NETWORK_TIMEOUT_MS = 8000;
/** Cap on runtime cache entries to bound storage on low-end devices. */
const MAX_STATIC_ENTRIES = 120;
const MAX_API_ENTRIES = 60;

// App shell — keep this list small; hashed bundles are cached at runtime.
const PRECACHE_ASSETS = [
  "/",
  "/index.html",
  OFFLINE_URL,
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

// ── Install ───────────────────────────────────────────────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(PRECACHE)
      .then((cache) =>
        // Cache individually so one missing asset doesn't sink the install.
        Promise.allSettled(PRECACHE_ASSETS.map((url) => cache.add(url))),
      )
      .then(() => self.skipWaiting()),
  );
});

// ── Activate: versioned cleanup + claim ───────────────────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith("np-") && !ACTIVE_CACHES.includes(name))
            // Also drop pre-versioning legacy cache names.
            .concat(names.filter((name) => !name.startsWith("np-")))
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// ── Fetch routing ─────────────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Mutations, webhooks, and non-GET traffic: network-only. Never cache
  // writes — replay is handled by the IndexedDB retry queue + sync tags.
  if (request.method !== "GET") return;
  if (
    url.pathname.startsWith("/api/payments") ||
    url.pathname.startsWith("/api/ussd") ||
    url.pathname.startsWith("/api/oauth") ||
    url.pathname.startsWith("/ws")
  ) {
    return;
  }

  // Same-origin tRPC queries: network-first with short-TTL cache fallback.
  if (url.origin === self.location.origin && url.pathname.startsWith("/api/trpc")) {
    event.respondWith(networkFirstApi(request));
    return;
  }

  // Other API paths: network-only (auth state, uploads, etc.).
  if (url.pathname.startsWith("/api/")) return;

  // Cross-origin: only cache known CDN/font hosts (SWR); ignore the rest.
  if (url.origin !== self.location.origin) {
    if (
      url.hostname.includes("cloudfront.net") ||
      url.hostname === "fonts.googleapis.com" ||
      url.hostname === "fonts.gstatic.com"
    ) {
      event.respondWith(staleWhileRevalidate(request, RUNTIME_STATIC, MAX_STATIC_ENTRIES));
    }
    return;
  }

  // Navigations: network-first, fall back to cached shell → offline.html.
  if (request.mode === "navigate") {
    event.respondWith(navigationHandler(request));
    return;
  }

  // Static assets (hashed Vite bundles, icons, images): SWR.
  event.respondWith(staleWhileRevalidate(request, RUNTIME_STATIC, MAX_STATIC_ENTRIES));
});

// ── Strategies ────────────────────────────────────────────────────────────────

async function navigationHandler(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(PRECACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached =
      (await caches.match(request)) ||
      (await caches.match("/")) ||
      (await caches.match("/index.html"));
    return cached || caches.match(OFFLINE_URL);
  }
}

async function staleWhileRevalidate(request, cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then(async (response) => {
      if (response.ok) {
        await cache.put(request, response.clone());
        trimCache(cacheName, maxEntries);
      }
      return response;
    })
    .catch(() => null);
  // Serve cache immediately if present; otherwise wait for the network.
  return cached || (await networkPromise) || Response.error();
}

async function networkFirstApi(request) {
  const cache = await caches.open(RUNTIME_API);
  try {
    const response = await fetchWithTimeout(request, API_NETWORK_TIMEOUT_MS);
    // Only cache successful, basic (same-origin) responses.
    if (response.ok) {
      const headers = new Headers(response.headers);
      headers.set("sw-cached-at", String(Date.now()));
      const body = await response.clone().blob();
      await cache.put(
        request,
        new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        }),
      );
      trimCache(RUNTIME_API, MAX_API_ENTRIES);
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) {
      const cachedAt = Number(cached.headers.get("sw-cached-at") || 0);
      // Honour the TTL for fast paths, but serve stale data when fully
      // offline — a stale balance beats an error screen in a tunnel.
      if (Date.now() - cachedAt < API_CACHE_TTL_MS || !navigator.onLine) {
        return cached;
      }
    }
    return new Response(
      JSON.stringify({ error: "OFFLINE", message: "You appear to be offline." }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }
}

function fetchWithTimeout(request, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(request, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

/** Evict oldest entries (FIFO by insertion order) beyond the cap. */
async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - maxEntries; i++) {
    await cache.delete(keys[i]);
  }
}

// ── Background Sync ───────────────────────────────────────────────────────────
// Fires when the browser decides the device has connectivity.
// The app registers sync tags via ServiceWorkerRegistration.sync.register().
self.addEventListener("sync", (event) => {
  if (event.tag === "np-retry-queue") {
    // Replay all pending offline mutations (incl. the KYC submit queue)
    event.waitUntil(replayRetryQueue());
  } else if (event.tag === "np-balance-refresh") {
    // Refresh wallet balance in background and notify open clients
    event.waitUntil(refreshWalletBalance());
  } else if (event.tag === "np-kyc-status-sync") {
    // Sync KYC application statuses for any pending applications
    event.waitUntil(syncKycStatuses());
  }
});

// ── Periodic Background Sync ──────────────────────────────────────────────────
// Requires 'periodic-background-sync' permission (Chrome 80+ on Android).
// Registered from the app with registration.periodicSync.register().
self.addEventListener("periodicsync", (event) => {
  if (event.tag === "np-periodic-balance") {
    event.waitUntil(refreshWalletBalance());
  } else if (event.tag === "np-periodic-status") {
    event.waitUntil(syncKycStatuses());
  }
});

// ── Background Sync Helpers ───────────────────────────────────────────────────

async function replayRetryQueue() {
  try {
    // Open IndexedDB directly in the SW (no import needed — same DB as the app)
    const db = await openIdb("nigerianpass_offline", 2);
    const items = await idbGetAll(db, "retry_queue", "status", "pending");

    let processed = 0;
    for (const item of items) {
      try {
        const response = await fetch(item.url, {
          method: item.method,
          headers: item.headers || {},
          body: item.body || null,
          signal: AbortSignal.timeout(20_000),
        });

        if (response.ok) {
          await idbDelete(db, "retry_queue", item.id);
          processed++;
        } else if (response.status >= 400 && response.status < 500) {
          await idbUpdate(db, "retry_queue", item.id, { status: "failed" });
        }
      } catch {
        // Network still unavailable — leave as pending
      }
    }

    if (processed > 0) {
      // Notify open windows about the sync result
      const clients = await self.clients.matchAll({ type: "window" });
      clients.forEach((client) =>
        client.postMessage({
          type: "SYNC_COMPLETE",
          processed,
          timestamp: Date.now(),
        }),
      );
    }
  } catch (err) {
    console.error("[SW] replayRetryQueue failed:", err);
  }
}

async function refreshWalletBalance() {
  try {
    const response = await fetch("/api/trpc/wallet.balance", {
      credentials: "include",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return;

    const data = await response.json();

    // Cache the balance in IndexedDB for offline display
    const db = await openIdb("nigerianpass_offline", 2);
    await idbPut(db, "cached_data", {
      cacheKey: "wallet_balance",
      data: data?.result?.data ?? data,
      cachedAt: Date.now(),
      expiresAt: Date.now() + 5 * 60 * 1000, // 5 min TTL
    });

    // Notify open windows
    const clients = await self.clients.matchAll({ type: "window" });
    clients.forEach((client) =>
      client.postMessage({
        type: "BALANCE_REFRESHED",
        balance: data?.result?.data ?? data,
        timestamp: Date.now(),
      }),
    );
  } catch (err) {
    console.error("[SW] refreshWalletBalance failed:", err);
  }
}

async function syncKycStatuses() {
  try {
    const response = await fetch("/api/trpc/kyc.myApplications", {
      credentials: "include",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return;

    const data = await response.json();
    const db = await openIdb("nigerianpass_offline", 2);
    await idbPut(db, "cached_data", {
      cacheKey: "kyc_applications",
      data: data?.result?.data ?? data,
      cachedAt: Date.now(),
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    const clients = await self.clients.matchAll({ type: "window" });
    clients.forEach((client) =>
      client.postMessage({
        type: "KYC_STATUS_SYNCED",
        applications: data?.result?.data ?? data,
        timestamp: Date.now(),
      }),
    );
  } catch (err) {
    console.error("[SW] syncKycStatuses failed:", err);
  }
}

// ── Minimal IndexedDB helpers (no import needed in SW) ────────────────────────

function openIdb(name, version) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = () => {}; // DB already created by the app
  });
}

function idbGetAll(db, storeName, indexName, indexValue) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const req = indexName
      ? store.index(indexName).getAll(indexValue)
      : store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db, storeName, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const req = tx.objectStore(storeName).put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbDelete(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const req = tx.objectStore(storeName).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function idbUpdate(db, storeName, key, updates) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    const getReq = store.get(key);
    getReq.onsuccess = () => {
      const updated = { ...getReq.result, ...updates };
      const putReq = store.put(updated);
      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

// ── Push notifications ────────────────────────────────────────────────────────
self.addEventListener("push", (event) => {
  let data = { title: "NigerianPass", body: "You have a new notification." };
  try {
    if (event.data) data = event.data.json();
  } catch {
    /* use defaults */
  }

  event.waitUntil(
    self.registration.showNotification(data.title || "NigerianPass", {
      body: data.body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-72.png",
      tag: data.tag || "np-notification",
      data: data.data || {},
      vibrate: [200, 100, 200],
      actions: [
        { action: "view", title: "View" },
        { action: "dismiss", title: "Dismiss" },
      ],
    }),
  );
});

// ── Notification click ────────────────────────────────────────────────────────
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  if (event.action === "dismiss") return;

  const url = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        const existing = clients.find((c) => c.url.includes(self.location.origin));
        if (existing) {
          existing.focus();
          existing.navigate(url);
        } else {
          self.clients.openWindow(url);
        }
      }),
  );
});
