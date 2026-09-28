/**
 * useServiceWorker
 * Registers /sw.js on mount and exposes update state.
 */
import { useEffect, useState } from "react";

interface SWState {
  isRegistered: boolean;
  hasUpdate: boolean;
  updateSW: () => void;
}

export function useServiceWorker(): SWState {
  const [isRegistered, setIsRegistered] = useState(false);
  const [hasUpdate, setHasUpdate] = useState(false);
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((reg) => {
        setIsRegistered(true);
        setRegistration(reg);

        // Check for updates
        reg.addEventListener("updatefound", () => {
          const newWorker = reg.installing;
          if (!newWorker) return;
          newWorker.addEventListener("statechange", () => {
            if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
              setHasUpdate(true);
            }
          });
        });
      })
      .catch((err) => {
        console.warn("SW registration failed:", err);
      });

    // Listen for controller change (after skipWaiting)
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      window.location.reload();
    });
  }, []);

  const updateSW = () => {
    if (!registration?.waiting) return;
    registration.waiting.postMessage({ type: "SKIP_WAITING" });
  };

  return { isRegistered, hasUpdate, updateSW };
}
