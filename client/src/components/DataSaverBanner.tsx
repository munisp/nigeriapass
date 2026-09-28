/**
 * DataSaverBanner
 * ================
 * A dismissible banner shown at the top of the app when:
 *  1. Data-saver mode was auto-detected (slow connection / Save-Data header)
 *  2. Data-saver mode is manually enabled
 *
 * Shows what is being skipped and allows the user to toggle the mode.
 */
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Gauge, X, Wifi, WifiOff, ChevronDown, ChevronUp, Zap } from "lucide-react";
import { useDataSaver } from "@/contexts/DataSaverContext";
import { cn } from "@/lib/utils";

export default function DataSaverBanner() {
  const { enabled, autoDetected, manualOverride, connectionType, estimatedSavingPercent, toggle, setManualOverride } = useDataSaver();
  const [dismissed, setDismissed] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Only show when data-saver is active and not dismissed
  if (!enabled || dismissed) return null;

  const isAuto = autoDetected && manualOverride === null;
  const label = isAuto
    ? `Slow connection detected (${connectionType.toUpperCase()}) — Data Saver active`
    : "Data Saver mode is on";

  return (
    <AnimatePresence>
      <motion.div
        initial={{ height: 0, opacity: 0 }}
        animate={{ height: "auto", opacity: 1 }}
        exit={{ height: 0, opacity: 0 }}
        transition={{ duration: 0.2 }}
        className="bg-amber-50 border-b border-amber-200 overflow-hidden"
      >
        <div className="px-4 py-2">
          <div className="flex items-center gap-2">
            <Gauge className="w-4 h-4 text-amber-600 shrink-0" />
            <span className="text-xs font-medium text-amber-800 flex-1">{label}</span>

            <div className="flex items-center gap-1">
              {/* Savings badge */}
              <span className="text-xs bg-amber-200 text-amber-800 px-1.5 py-0.5 rounded-full font-semibold">
                ~{estimatedSavingPercent}% less data
              </span>

              {/* Expand/collapse */}
              <button
                onClick={() => setExpanded(e => !e)}
                className="p-1 rounded hover:bg-amber-200 transition-colors"
                aria-label={expanded ? "Collapse" : "Expand"}
              >
                {expanded ? <ChevronUp className="w-3.5 h-3.5 text-amber-700" /> : <ChevronDown className="w-3.5 h-3.5 text-amber-700" />}
              </button>

              {/* Dismiss */}
              <button
                onClick={() => setDismissed(true)}
                className="p-1 rounded hover:bg-amber-200 transition-colors"
                aria-label="Dismiss"
              >
                <X className="w-3.5 h-3.5 text-amber-700" />
              </button>
            </div>
          </div>

          {/* Expanded details */}
          <AnimatePresence>
            {expanded && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="mt-2 overflow-hidden"
              >
                <div className="grid grid-cols-2 gap-1.5 mb-2">
                  {[
                    { label: "Map tiles", skipped: true },
                    { label: "Videos", skipped: true },
                    { label: "Animations", skipped: true },
                    { label: "Decorative images", skipped: true },
                    { label: "Photo uploads compressed", skipped: false, note: "≤200 KB" },
                    { label: "API polling", skipped: false, note: "2× interval" },
                  ].map(item => (
                    <div key={item.label} className="flex items-center gap-1.5 text-xs text-amber-700">
                      <span className={cn(
                        "w-1.5 h-1.5 rounded-full shrink-0",
                        item.skipped ? "bg-red-400" : "bg-amber-400"
                      )} />
                      <span>{item.label}</span>
                      {item.note && <span className="text-amber-500">({item.note})</span>}
                    </div>
                  ))}
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={toggle}
                    className="flex items-center gap-1.5 text-xs font-medium text-amber-800 bg-amber-200 hover:bg-amber-300 px-2.5 py-1 rounded-lg transition-colors"
                  >
                    <Zap className="w-3 h-3" />
                    Turn off Data Saver
                  </button>
                  {isAuto && (
                    <button
                      onClick={() => setManualOverride(true)}
                      className="flex items-center gap-1.5 text-xs font-medium text-amber-700 hover:text-amber-900 px-2 py-1 rounded-lg transition-colors"
                    >
                      Keep always on
                    </button>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
