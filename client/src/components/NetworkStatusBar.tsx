/**
 * NetworkStatusBar
 *
 * Sticky top banner that appears when:
 *  - User is offline
 *  - Connection is 2G/slow-2G
 *  - There are pending retry items
 *  - Battery is critically low
 *
 * Designed for Nigerian low-connectivity UX — clear, non-intrusive,
 * actionable messaging in plain English.
 */
import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { WifiOff, Wifi, Battery, AlertTriangle, RefreshCw, CheckCircle2, Loader2 } from "lucide-react";
import { useOffline } from "@/hooks/useOffline";
import { cn } from "@/lib/utils";

export default function NetworkStatusBar() {
  const { network, battery, pendingRetries, processQueue } = useOffline();
  const [processing, setProcessing] = useState(false);
  const [justSynced, setJustSynced] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // Reset dismissed state when going offline
  useEffect(() => {
    if (!network.online) setDismissed(false);
  }, [network.online]);

  const handleSync = async () => {
    setProcessing(true);
    await processQueue();
    setProcessing(false);
    setJustSynced(true);
    setTimeout(() => setJustSynced(false), 3000);
  };

  // Determine what to show
  const isOffline = !network.online;
  const isSlow = network.isSlowConnection && network.online;
  const hasPending = pendingRetries > 0;
  const isBatteryLow = battery.isLow && !battery.charging;
  const isBatteryCritical = battery.isCritical && !battery.charging;

  const shouldShow = (isOffline || isSlow || hasPending || isBatteryCritical) && !dismissed;

  if (!shouldShow) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ y: -40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: -40, opacity: 0 }}
        transition={{ duration: 0.25 }}
        className={cn(
          "sticky top-0 z-50 w-full text-sm font-medium",
          isOffline ? "bg-red-600 text-white" :
          isBatteryCritical ? "bg-red-500 text-white" :
          hasPending ? "bg-amber-500 text-white" :
          isSlow ? "bg-amber-400 text-amber-900" :
          "bg-blue-500 text-white"
        )}
      >
        <div className="max-w-screen-xl mx-auto px-4 py-2 flex items-center gap-3 flex-wrap">

          {/* Icon */}
          <div className="shrink-0">
            {isOffline ? <WifiOff className="w-4 h-4" /> :
             isBatteryCritical ? <Battery className="w-4 h-4" /> :
             hasPending ? <AlertTriangle className="w-4 h-4" /> :
             isSlow ? <Wifi className="w-4 h-4 opacity-60" /> :
             <CheckCircle2 className="w-4 h-4" />}
          </div>

          {/* Message */}
          <div className="flex-1 min-w-0">
            {isOffline && (
              <span>
                <strong>No internet connection.</strong>{" "}
                Your form progress is saved locally. Changes will sync when you reconnect.
              </span>
            )}
            {!isOffline && isSlow && !hasPending && (
              <span>
                <strong>Slow connection detected</strong> ({network.effectiveType.toUpperCase()}).
                Large uploads may take longer. Your progress is auto-saved.
              </span>
            )}
            {!isOffline && hasPending && (
              <span>
                <strong>{pendingRetries} submission{pendingRetries > 1 ? "s" : ""} pending.</strong>{" "}
                {justSynced ? "Synced successfully!" : "Tap Sync to upload now."}
              </span>
            )}
            {!isOffline && !hasPending && isBatteryCritical && (
              <span>
                <strong>Battery critically low ({Math.round(battery.level * 100)}%).</strong>{" "}
                Connect a charger to avoid losing your session.
              </span>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 shrink-0">
            {!isOffline && hasPending && !justSynced && (
              <button
                onClick={handleSync}
                disabled={processing}
                className="flex items-center gap-1.5 px-3 py-1 bg-white/20 hover:bg-white/30 rounded-lg text-xs font-semibold transition-colors"
              >
                {processing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                {processing ? "Syncing..." : "Sync Now"}
              </button>
            )}
            {justSynced && (
              <span className="flex items-center gap-1 text-xs">
                <CheckCircle2 className="w-3.5 h-3.5" /> Synced
              </span>
            )}
            {(isSlow || isBatteryCritical) && !hasPending && (
              <button
                onClick={() => setDismissed(true)}
                className="text-xs opacity-70 hover:opacity-100 underline underline-offset-2"
              >
                Dismiss
              </button>
            )}
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
