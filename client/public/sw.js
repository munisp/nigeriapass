/**
 * NigerianPass Service Worker
 * Strategy: Cache-first for static assets, network-first for API calls
 * Offline fallback: /offline.html for navigation requests
 */

const CACHE_NAME = "nigerianpass-v1";
const OFFLINE_URL = "/offline.html";

// Assets to pre-cache on install
const PRECACHE_ASSETS = [
  "/",
  "/offline.html",
  "/manifest.json",
];

// ── Install ───────────────────────────────────────────────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS).catch(() => {
        // Silently fail if some assets aren't available yet
      });
    }).then(() => self.skipWaiting())
  );
});

// ── Activate ──────────────────────────────────────────────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and cross-origin requests
  if (request.method !== "GET") return;
  if (url.origin !== self.location.origin && !url.hostname.includes("cloudfront.net")) return;

  // API requests: network-first, no cache
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/")) return;

  // Navigation requests: network-first with offline fallback
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Cache successful navigation responses
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(async () => {
          // Offline — serve cached page or offline fallback
          const cached = await caches.match(request);
          if (cached) return cached;
          // SPA fallback: return cached root
          const root = await caches.match("/");
          if (root) return root;
          return caches.match(OFFLINE_URL);
        })
    );
    return;
  }

  // Static assets: cache-first
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (!response.ok) return response;
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        return response;
      }).catch(() => caches.match(OFFLINE_URL));
    })
  );
});

// ── Background Sync ─────────────────────────────────────────────────────────
// Fires when the browser decides the device has connectivity.
// The app registers sync tags via ServiceWorkerRegistration.sync.register().
self.addEventListener("sync", (event) => {
  if (event.tag === "np-retry-queue") {
    // Replay all pending offline mutations
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
      clients.forEach(client => client.postMessage({
        type: "SYNC_COMPLETE",
        processed,
        timestamp: Date.now(),
      }));
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
    clients.forEach(client => client.postMessage({
      type: "BALANCE_REFRESHED",
      balance: data?.result?.data ?? data,
      timestamp: Date.now(),
    }));
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
    clients.forEach(client => client.postMessage({
      type: "KYC_STATUS_SYNCED",
      applications: data?.result?.data ?? data,
      timestamp: Date.now(),
    }));
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
  } catch { /* use defaults */ }

  event.waitUntil(
    self.registration.showNotification(data.title || "NigerianPass", {
      body: data.body,
      icon: "https://d2xsxph8kpxj0f.cloudfront.net/114501028/9uoCntQGmxrFDSX5CAeixb/icon-192_7110dc9d.png",
      badge: "https://d2xsxph8kpxj0f.cloudfront.net/114501028/9uoCntQGmxrFDSX5CAeixb/icon-72_dd31ccfd.png",
      tag: data.tag || "np-notification",
      data: data.data || {},
      vibrate: [200, 100, 200],
      actions: [
        { action: "view", title: "View" },
        { action: "dismiss", title: "Dismiss" },
      ],
    })
  );
});

// ── Notification click ────────────────────────────────────────────────────────
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  if (event.action === "dismiss") return;

  const url = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((c) => c.url.includes(self.location.origin));
      if (existing) {
        existing.focus();
        existing.navigate(url);
      } else {
        self.clients.openWindow(url);
      }
    })
  );
});
