/**
 * OfflineDashboard
 *
 * Shows users their offline health at a glance:
 *  - Network quality and connection type
 *  - Battery state
 *  - Pending sync queue with retry controls
 *  - Saved form drafts with resume/discard
 *  - Storage quota usage
 *  - Persistent storage status
 *
 * Accessible from the mobile nav and portal sidebar.
 */
import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  Wifi, WifiOff, Battery, BatteryCharging, BatteryLow,
  RefreshCw, Trash2, FileText, CheckCircle2, AlertTriangle,
  HardDrive, Loader2, ArrowRight, Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useOffline } from "@/hooks/useOffline";
import { getAllDrafts, deleteDraft, getPendingRetries, deleteRetryItem, RetryItem } from "@/lib/offline";
import { cn } from "@/lib/utils";
import { Link } from "wouter";
import { toast } from "sonner";

const FORM_LABELS: Record<string, string> = {
  "driver-kyc": "Driver KYC",
  "vehicle-reg": "Vehicle Registration",
  "fleet-kyb": "Fleet KYB",
};

const FORM_HREFS: Record<string, string> = {
  "driver-kyc": "/onboarding/driver",
  "vehicle-reg": "/onboarding/vehicle",
  "fleet-kyb": "/onboarding/fleet",
};

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return "just now";
}

export default function OfflineDashboard() {
  const { network, battery, pendingRetries, storageUsedPct, isPersistentStorage, processQueue } = useOffline();
  const [drafts, setDrafts] = useState<Awaited<ReturnType<typeof getAllDrafts>>>([]);
  const [retries, setRetries] = useState<RetryItem[]>([]);
  const [processing, setProcessing] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    const [d, r] = await Promise.all([getAllDrafts(), getPendingRetries()]);
    setDrafts(d);
    setRetries(r);
    setLoading(false);
  };

  useEffect(() => { refresh(); }, []);

  const handleSync = async () => {
    setProcessing(true);
    await processQueue();
    await refresh();
    setProcessing(false);
    toast.success("Sync complete");
  };

  const handleDiscardDraft = async (formId: string) => {
    await deleteDraft(formId);
    await refresh();
    toast.info("Draft discarded");
  };

  const handleDiscardRetry = async (id: number) => {
    await deleteRetryItem(id);
    await refresh();
    toast.info("Queued item removed");
  };

  const connectionColor = !network.online ? "text-red-600" :
    network.isSlowConnection ? "text-amber-600" : "text-emerald-600";

  const connectionBg = !network.online ? "bg-red-50 border-red-200" :
    network.isSlowConnection ? "bg-amber-50 border-amber-200" : "bg-emerald-50 border-emerald-200";

  return (
    <div className="min-h-screen bg-[oklch(0.975_0.003_255)] p-4 md:p-6 pb-24 md:pb-6">
      <div className="max-w-2xl mx-auto space-y-5">

        {/* Header */}
        <div>
          <h1 className="text-xl font-bold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
            Offline & Sync Status
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Your data is safe even without internet. Everything syncs automatically when you reconnect.
          </p>
        </div>

        {/* Network card */}
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
          className={cn("rounded-2xl border p-4", connectionBg)}>
          <div className="flex items-center gap-3">
            <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center",
              !network.online ? "bg-red-100" : network.isSlowConnection ? "bg-amber-100" : "bg-emerald-100")}>
              {network.online ? <Wifi className={cn("w-5 h-5", connectionColor)} /> :
                <WifiOff className="w-5 h-5 text-red-600" />}
            </div>
            <div className="flex-1">
              <div className={cn("font-semibold text-sm", connectionColor)}>
                {!network.online ? "Offline" :
                  network.isSlowConnection ? `Slow connection (${network.effectiveType.toUpperCase()})` :
                  `Connected (${network.effectiveType.toUpperCase()})`}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {network.online
                  ? `Downlink: ${network.downlink} Mbps · RTT: ${network.rtt}ms${network.saveData ? " · Data Saver ON" : ""}`
                  : "Your form progress is saved locally and will sync when you reconnect."}
              </div>
            </div>
            <div className={cn("w-2.5 h-2.5 rounded-full animate-pulse",
              !network.online ? "bg-red-500" : network.isSlowConnection ? "bg-amber-500" : "bg-emerald-500")} />
          </div>
        </motion.div>

        {/* Battery card */}
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}
          className="bg-white rounded-2xl border border-border p-4 shadow-sm">
          <div className="flex items-center gap-3">
            <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center",
              battery.isCritical && !battery.charging ? "bg-red-100" :
              battery.isLow && !battery.charging ? "bg-amber-100" : "bg-slate-100")}>
              {battery.charging ? <BatteryCharging className="w-5 h-5 text-emerald-600" /> :
               battery.isLow ? <BatteryLow className="w-5 h-5 text-amber-600" /> :
               <Battery className="w-5 h-5 text-slate-600" />}
            </div>
            <div className="flex-1">
              <div className="font-semibold text-sm text-foreground">
                Battery: {Math.round(battery.level * 100)}%
                {battery.charging && <span className="ml-2 text-xs text-emerald-600 font-normal">Charging</span>}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {battery.isCritical && !battery.charging
                  ? "⚠ Critical — connect a charger to avoid losing your session"
                  : battery.isLow && !battery.charging
                  ? "Low battery — consider connecting a charger"
                  : "Battery level is fine"}
              </div>
            </div>
            {/* Battery bar */}
            <div className="w-16 h-3 bg-muted rounded-full overflow-hidden">
              <div className={cn("h-full rounded-full transition-all",
                battery.level < 0.1 ? "bg-red-500" :
                battery.level < 0.2 ? "bg-amber-500" :
                battery.charging ? "bg-emerald-500" : "bg-blue-500")}
                style={{ width: `${battery.level * 100}%` }} />
            </div>
          </div>
        </motion.div>

        {/* Sync queue */}
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}
          className="bg-white rounded-2xl border border-border p-4 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-sm text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
              Pending Sync ({retries.length})
            </h3>
            {retries.length > 0 && network.online && (
              <Button size="sm" onClick={handleSync} disabled={processing} className="gap-1.5 text-xs h-7">
                {processing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                {processing ? "Syncing..." : "Sync All"}
              </Button>
            )}
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : retries.length === 0 ? (
            <div className="flex items-center gap-2 py-3 text-sm text-emerald-700">
              <CheckCircle2 className="w-4 h-4 text-emerald-500" />
              All submissions are synced
            </div>
          ) : (
            <div className="space-y-2">
              {retries.map(item => (
                <div key={item.id} className="flex items-center gap-3 p-3 bg-amber-50 border border-amber-200 rounded-xl">
                  <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-amber-900 truncate">{item.label}</div>
                    <div className="text-xs text-amber-700">
                      {item.attempts} attempt{item.attempts !== 1 ? "s" : ""} · {timeAgo(item.createdAt)}
                    </div>
                  </div>
                  <button onClick={() => item.id && handleDiscardRetry(item.id)}
                    className="text-amber-500 hover:text-red-600 transition-colors">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </motion.div>

        {/* Saved drafts */}
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}
          className="bg-white rounded-2xl border border-border p-4 shadow-sm">
          <h3 className="font-semibold text-sm text-foreground mb-3" style={{ fontFamily: "Sora, sans-serif" }}>
            Saved Drafts ({drafts.length})
          </h3>

          {loading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : drafts.length === 0 ? (
            <div className="text-sm text-muted-foreground py-3">No saved drafts</div>
          ) : (
            <div className="space-y-2">
              {drafts.map(draft => (
                <div key={draft.formId} className="flex items-center gap-3 p-3 bg-blue-50 border border-blue-200 rounded-xl">
                  <FileText className="w-4 h-4 text-blue-600 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-blue-900">
                      {FORM_LABELS[draft.formId] ?? draft.formId}
                    </div>
                    <div className="text-xs text-blue-700 flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      Saved {timeAgo(draft.updatedAt)}
                      {draft.step > 0 && ` · Step ${draft.step + 1}`}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {FORM_HREFS[draft.formId] && (
                      <Link href={FORM_HREFS[draft.formId]}>
                        <button className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 font-medium">
                          Resume <ArrowRight className="w-3 h-3" />
                        </button>
                      </Link>
                    )}
                    <button onClick={() => handleDiscardDraft(draft.formId)}
                      className="text-blue-400 hover:text-red-500 transition-colors ml-1">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </motion.div>

        {/* Storage */}
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}
          className="bg-white rounded-2xl border border-border p-4 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center">
              <HardDrive className="w-5 h-5 text-slate-600" />
            </div>
            <div className="flex-1">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-sm font-semibold text-foreground">Local Storage</span>
                <span className="text-xs text-muted-foreground">{storageUsedPct}% used</span>
              </div>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div className={cn("h-full rounded-full transition-all",
                  storageUsedPct > 80 ? "bg-red-500" :
                  storageUsedPct > 60 ? "bg-amber-500" : "bg-blue-500")}
                  style={{ width: `${storageUsedPct}%` }} />
              </div>
              <div className="text-xs text-muted-foreground mt-1.5">
                {isPersistentStorage
                  ? "✓ Persistent storage granted — your data won't be evicted"
                  : "Storage may be cleared by the browser if device runs low on space"}
              </div>
            </div>
          </div>
        </motion.div>

        {/* Tips */}
        <div className="bg-[#1B2B4B] rounded-2xl p-4 text-white">
          <h3 className="font-semibold text-sm mb-3" style={{ fontFamily: "Sora, sans-serif" }}>
            Tips for low-connectivity areas
          </h3>
          <ul className="space-y-2 text-xs text-blue-200">
            <li className="flex items-start gap-2">
              <span className="text-emerald-400 mt-0.5">✓</span>
              Your form progress saves automatically every 3 seconds — even if you lose power mid-form.
            </li>
            <li className="flex items-start gap-2">
              <span className="text-emerald-400 mt-0.5">✓</span>
              Document photos are queued locally and uploaded when you reconnect.
            </li>
            <li className="flex items-start gap-2">
              <span className="text-emerald-400 mt-0.5">✓</span>
              On 2G, disable video/animations in Settings to save data.
            </li>
            <li className="flex items-start gap-2">
              <span className="text-emerald-400 mt-0.5">✓</span>
              No internet? Dial <strong className="text-white">*346#</strong> on any phone to check your balance.
            </li>
          </ul>
        </div>

      </div>
    </div>
  );
}
