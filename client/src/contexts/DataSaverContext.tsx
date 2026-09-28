/**
 * DataSaverContext
 * ================
 * Provides a global data-saver mode that adapts the app for low-bandwidth
 * Nigerian network conditions (2G/EDGE, Save-Data header).
 *
 * When data-saver is active:
 *  - Framer Motion animations are disabled (LazyMotion with no features)
 *  - Google Maps tile layer is skipped (map still renders, no background tiles)
 *  - Document/photo uploads are compressed to ≤ 200 KB before sending
 *  - Heavy assets (hero images, background videos) are replaced with placeholders
 *  - API polling intervals are doubled
 *
 * The mode can be:
 *  1. Auto-detected from navigator.connection.saveData or effectiveType === "2g"
 *  2. Manually toggled by the user in Settings
 *  3. Persisted in localStorage so it survives page reloads
 */
import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from "react";
import { getNetworkState } from "@/lib/offline";

export interface DataSaverState {
  enabled: boolean;
  autoDetected: boolean;
  manualOverride: boolean | null;  // null = follow auto, true/false = forced
  connectionType: string;
  estimatedSavingPercent: number;  // rough % of data saved vs normal mode
}

interface DataSaverContextValue extends DataSaverState {
  toggle: () => void;
  setManualOverride: (value: boolean | null) => void;
  compressImage: (file: File, maxKB?: number) => Promise<File>;
  shouldLoadHeavyAsset: (assetType: "image" | "video" | "map" | "animation") => boolean;
  getPollingInterval: (baseMs: number) => number;
}

const DataSaverContext = createContext<DataSaverContextValue | null>(null);

const STORAGE_KEY = "np_data_saver_override";

// ── Image compression utility ─────────────────────────────────────────────────
async function compressImageFile(file: File, maxKB = 200): Promise<File> {
  const maxBytes = maxKB * 1024;
  if (file.size <= maxBytes) return file;

  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement("canvas");

      // Scale down proportionally to fit within maxBytes
      let { width, height } = img;
      const scaleFactor = Math.sqrt(maxBytes / file.size);
      width = Math.round(width * scaleFactor);
      height = Math.round(height * scaleFactor);

      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext("2d");
      if (!ctx) { resolve(file); return; }

      ctx.drawImage(img, 0, 0, width, height);

      // Try JPEG at decreasing quality until we hit the target size
      let quality = 0.8;
      const tryCompress = () => {
        canvas.toBlob((blob) => {
          if (!blob) { resolve(file); return; }
          if (blob.size <= maxBytes || quality <= 0.3) {
            resolve(new File([blob], file.name.replace(/\.[^.]+$/, ".jpg"), {
              type: "image/jpeg",
              lastModified: Date.now(),
            }));
          } else {
            quality -= 0.1;
            tryCompress();
          }
        }, "image/jpeg", quality);
      };
      tryCompress();
    };

    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

// ── Provider ──────────────────────────────────────────────────────────────────
export function DataSaverProvider({ children }: { children: ReactNode }) {
  const [manualOverride, setManualOverrideState] = useState<boolean | null>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "true") return true;
      if (stored === "false") return false;
      return null;
    } catch { return null; }
  });

  const [autoDetected, setAutoDetected] = useState(false);
  const [connectionType, setConnectionType] = useState("unknown");

  // ── Detect network conditions ───────────────────────────────────────────────
  useEffect(() => {
    const detect = () => {
      const net = getNetworkState();
      const isSlowOrSaveData = net.saveData || net.isSlowConnection ||
        net.effectiveType === "2g" || net.effectiveType === "slow-2g";
      setAutoDetected(isSlowOrSaveData);
      setConnectionType(net.effectiveType || net.type || "unknown");
    };

    detect();

    const nav = navigator as any;
    const conn = nav.connection || nav.mozConnection || nav.webkitConnection;
    if (conn) conn.addEventListener("change", detect);
    window.addEventListener("online", detect);
    window.addEventListener("offline", detect);

    return () => {
      if (conn) conn.removeEventListener("change", detect);
      window.removeEventListener("online", detect);
      window.removeEventListener("offline", detect);
    };
  }, []);

  // ── Compute effective enabled state ────────────────────────────────────────
  const enabled = manualOverride !== null ? manualOverride : autoDetected;

  // ── Estimate data savings ───────────────────────────────────────────────────
  const estimatedSavingPercent = enabled ? 60 : 0;

  // ── Toggle ──────────────────────────────────────────────────────────────────
  const toggle = useCallback(() => {
    setManualOverrideState(prev => {
      const next = prev === null ? !autoDetected : !prev;
      try { localStorage.setItem(STORAGE_KEY, String(next)); } catch { /* ignore */ }
      return next;
    });
  }, [autoDetected]);

  const setManualOverride = useCallback((value: boolean | null) => {
    setManualOverrideState(value);
    try {
      if (value === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, String(value));
    } catch { /* ignore */ }
  }, []);

  // ── Asset loading decision ──────────────────────────────────────────────────
  const shouldLoadHeavyAsset = useCallback((assetType: "image" | "video" | "map" | "animation") => {
    if (!enabled) return true;
    switch (assetType) {
      case "video": return false;        // Never load videos on data-saver
      case "map": return false;          // Skip map tile layer
      case "animation": return false;    // Disable Framer Motion
      case "image": return false;        // Skip decorative images
      default: return true;
    }
  }, [enabled]);

  // ── Polling interval multiplier ─────────────────────────────────────────────
  const getPollingInterval = useCallback((baseMs: number) => {
    return enabled ? baseMs * 2 : baseMs;
  }, [enabled]);

  // ── Image compression ───────────────────────────────────────────────────────
  const compressImage = useCallback(async (file: File, maxKB = 200): Promise<File> => {
    if (!enabled) return file;
    return compressImageFile(file, maxKB);
  }, [enabled]);

  const value: DataSaverContextValue = {
    enabled,
    autoDetected,
    manualOverride,
    connectionType,
    estimatedSavingPercent,
    toggle,
    setManualOverride,
    compressImage,
    shouldLoadHeavyAsset,
    getPollingInterval,
  };

  return (
    <DataSaverContext.Provider value={value}>
      {children}
    </DataSaverContext.Provider>
  );
}

// ── Hook ──────────────────────────────────────────────────────────────────────
export function useDataSaver(): DataSaverContextValue {
  const ctx = useContext(DataSaverContext);
  if (!ctx) throw new Error("useDataSaver must be used within DataSaverProvider");
  return ctx;
}
