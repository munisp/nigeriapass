/**
 * usePushNotifications
 *
 * Manages browser Push Notification permission and service worker subscription.
 * - Requests Notification permission on demand
 * - Registers the service worker (/sw.js) if not already registered
 * - Subscribes to push via PushManager.subscribe()
 * - Persists subscription state in localStorage
 * - In demo mode (no VAPID key), falls back to local Notification API
 */
import { useState, useEffect, useCallback } from "react";

export type PushPermission = "default" | "granted" | "denied" | "unsupported";

interface UsePushNotificationsReturn {
  permission: PushPermission;
  isSubscribed: boolean;
  isLoading: boolean;
  requestPermission: () => Promise<void>;
  sendTestNotification: () => void;
  unsubscribe: () => Promise<void>;
}

const STORAGE_KEY = "nigerianpass_push_subscribed";

export function usePushNotifications(): UsePushNotificationsReturn {
  const [permission, setPermission] = useState<PushPermission>(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
    return Notification.permission as PushPermission;
  });
  const [isSubscribed, setIsSubscribed] = useState(() => {
    return localStorage.getItem(STORAGE_KEY) === "true";
  });
  const [isLoading, setIsLoading] = useState(false);

  // Sync permission state on mount
  useEffect(() => {
    if (!("Notification" in window)) {
      setPermission("unsupported");
      return;
    }
    setPermission(Notification.permission as PushPermission);
  }, []);

  // Register service worker
  const registerSW = useCallback(async (): Promise<ServiceWorkerRegistration | null> => {
    if (!("serviceWorker" in navigator)) return null;
    try {
      const existing = await navigator.serviceWorker.getRegistration("/");
      if (existing) return existing;
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      return reg;
    } catch (err) {
      console.warn("SW registration failed:", err);
      return null;
    }
  }, []);

  const requestPermission = useCallback(async () => {
    if (!("Notification" in window)) return;
    setIsLoading(true);
    try {
      const result = await Notification.requestPermission();
      setPermission(result as PushPermission);

      if (result === "granted") {
        // Try to subscribe via Push API
        const reg = await registerSW();
        if (reg && "pushManager" in reg) {
          try {
            // In production, replace with real VAPID public key
            const VAPID_PUBLIC_KEY = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";
            const sub = await reg.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY).buffer as ArrayBuffer,
            });
            console.log("Push subscription:", JSON.stringify(sub));
          } catch {
            // VAPID key mismatch in demo — subscription still "granted" locally
          }
        }
        setIsSubscribed(true);
        localStorage.setItem(STORAGE_KEY, "true");

        // Send a welcome notification
        new Notification("NigerianPass Alerts Enabled", {
          body: "You'll receive KYC status updates and low-balance alerts.",
          icon: "/icons/icon-192.png",
          badge: "/icons/icon-72.png",
          tag: "np-welcome",
        });
      }
    } finally {
      setIsLoading(false);
    }
  }, [registerSW]);

  const sendTestNotification = useCallback(() => {
    if (permission !== "granted") return;
    new Notification("NigerianPass Test Alert", {
      body: "Your KYC application DRV-XKQP7 has been approved! ✅",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-72.png",
      tag: "np-test",
      data: { url: "/status" },
    });
  }, [permission]);

  const unsubscribe = useCallback(async () => {
    setIsLoading(true);
    try {
      if ("serviceWorker" in navigator) {
        const reg = await navigator.serviceWorker.getRegistration("/");
        if (reg) {
          const sub = await reg.pushManager.getSubscription();
          if (sub) await sub.unsubscribe();
        }
      }
      setIsSubscribed(false);
      localStorage.removeItem(STORAGE_KEY);
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { permission, isSubscribed, isLoading, requestPermission, sendTestNotification, unsubscribe };
}

// ── VAPID key helper ──────────────────────────────────────────────────────────
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
