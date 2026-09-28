/**
 * Admin Reconciliation Page — /portal/reconciliation
 * ====================================================
 * Allows admins to:
 *  - View the last reconciliation run: timestamp, duration, processed/credited/failed/skipped counts
 *  - Trigger a manual "Run Now" reconciliation job
 *  - See a live activity log of the current run
 *  - View historical run records stored in localStorage (up to 20 entries)
 *
 * Design: Premium Civic — Navy authority base, Sora + Nunito Sans
 */
import { useState, useCallback, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  RefreshCw, CheckCircle2, XCircle, Clock, AlertTriangle,
  PlayCircle, History, ChevronDown, ChevronUp, Zap,
  TrendingUp, SkipForward, Activity, ExternalLink, X as XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import PortalLayout from "@/components/PortalLayout";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ReconciliationRun {
  id: string | number;
  startedAt: string | number; // ISO string from DB or epoch ms from local
  durationMs: number;
  processed: number;
  credited: number;
  failed: number;
  skipped: number;
  errors: string[];
  triggeredBy: string;
  status?: string;
}

// ── Stat card ─────────────────────────────────────────────────────────────────

interface StatCardProps {
  label: string;
  value: number | string;
  icon: React.ElementType;
  color: string;
  bg: string;
  description?: string;
}

function StatCard({ label, value, icon: Icon, color, bg, description }: StatCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-white rounded-xl border border-border p-5 flex flex-col gap-3"
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-muted-foreground">{label}</span>
        <div className={cn("w-9 h-9 rounded-lg flex items-center justify-center", bg)}>
          <Icon className={cn("w-4 h-4", color)} />
        </div>
      </div>
      <div className="text-3xl font-bold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
        {value}
      </div>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
    </motion.div>
  );
}

// ── Run detail modal ─────────────────────────────────────────────────────────

function RunDetailModal({ run, onClose }: { run: ReconciliationRun; onClose: () => void }) {
  const date = new Date(typeof run.startedAt === 'string' ? run.startedAt : run.startedAt);
  const statusColor = run.failed > 0 ? "text-red-600" : run.credited > 0 ? "text-emerald-600" : "text-slate-500";
  const statusLabel = run.failed > 0 ? "Completed with errors" : run.credited > 0 ? "Completed successfully" : "No transactions found";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 16 }}
        transition={{ duration: 0.18 }}
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <h2 className="text-base font-semibold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
              Run #{typeof run.id === 'number' ? run.id : run.id}
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {date.toLocaleString("en-NG", {
                day: "numeric", month: "long", year: "numeric",
                hour: "2-digit", minute: "2-digit", second: "2-digit",
              })}
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:bg-muted transition-colors"
          >
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 p-5 space-y-5">
          {/* Status + trigger */}
          <div className="flex items-center justify-between">
            <span className={`text-sm font-medium ${statusColor}`}>{statusLabel}</span>
            <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
              {run.triggeredBy === "manual" ? "Manual" : "Scheduled (02:00 WAT)"}
            </span>
          </div>

          {/* Metrics grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: "Processed", value: run.processed, color: "text-slate-700" },
              { label: "Credited", value: run.credited, color: "text-emerald-600" },
              { label: "Skipped", value: run.skipped, color: "text-amber-600" },
              { label: "Failed", value: run.failed, color: "text-red-600" },
            ].map(m => (
              <div key={m.label} className="bg-muted/40 rounded-xl p-3 text-center">
                <div className={`text-xl font-bold ${m.color}`}>{m.value}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{m.label}</div>
              </div>
            ))}
          </div>

          {/* Duration */}
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Clock className="w-4 h-4" />
            <span>Duration: <span className="text-foreground font-medium">
              {run.durationMs < 1000 ? `${run.durationMs}ms` : `${(run.durationMs / 1000).toFixed(2)}s`}
            </span></span>
          </div>

          {/* Full errors list */}
          {run.errors.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <XCircle className="w-4 h-4 text-red-500" />
                <span className="text-sm font-semibold text-red-700">
                  {run.errors.length} Error{run.errors.length !== 1 ? "s" : ""}
                </span>
              </div>
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {run.errors.map((err, i) => (
                  <div
                    key={i}
                    className="text-xs bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-red-700 font-mono break-all"
                  >
                    <span className="text-red-400 mr-2">[{i + 1}]</span>{err}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* No errors / no transactions */}
          {run.errors.length === 0 && run.processed === 0 && (
            <div className="text-sm text-muted-foreground italic text-center py-2">
              No pending transactions found — nothing to reconcile.
            </div>
          )}

          {run.errors.length === 0 && run.processed > 0 && (
            <div className="flex items-center gap-2 text-sm text-emerald-600">
              <CheckCircle2 className="w-4 h-4" />
              <span>All transactions processed without errors.</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border bg-muted/20 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            Run ID: <span className="font-mono">{run.id}</span>
          </span>
          <button
            onClick={onClose}
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Close
          </button>
        </div>
      </motion.div>
    </div>
  );
}

// ── Run history row ───────────────────────────────────────────────────────────

function RunRow({ run, index }: { run: ReconciliationRun; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const date = new Date(typeof run.startedAt === 'string' ? run.startedAt : run.startedAt);
  const hasErrors = run.errors.length > 0;

  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.04 }}
      className="border border-border rounded-lg overflow-hidden"
    >
      <button
        className="w-full flex items-center gap-4 px-4 py-3 bg-white hover:bg-muted/30 transition-colors text-left"
        onClick={() => setExpanded(e => !e)}
      >
        {/* Status dot */}
        <div className={cn(
          "w-2 h-2 rounded-full shrink-0",
          run.failed > 0 ? "bg-red-500" : run.credited > 0 ? "bg-emerald-500" : "bg-slate-400"
        )} />

        {/* Timestamp */}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-foreground">
            {date.toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" })}
            {" "}
            <span className="text-muted-foreground font-normal">
              {date.toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit" })}
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            {run.triggeredBy === "manual" ? "Manual trigger" : "Scheduled (02:00 WAT)"}
            {" · "}
            {run.durationMs < 1000
              ? `${run.durationMs}ms`
              : `${(run.durationMs / 1000).toFixed(1)}s`}
          </div>
        </div>

        {/* Counters */}
        <div className="hidden sm:flex items-center gap-4 text-xs">
          <span className="flex items-center gap-1 text-slate-500">
            <Activity className="w-3 h-3" /> {run.processed}
          </span>
          <span className="flex items-center gap-1 text-emerald-600">
            <CheckCircle2 className="w-3 h-3" /> {run.credited}
          </span>
          <span className="flex items-center gap-1 text-amber-600">
            <SkipForward className="w-3 h-3" /> {run.skipped}
          </span>
          {run.failed > 0 && (
            <span className="flex items-center gap-1 text-red-600">
              <XCircle className="w-3 h-3" /> {run.failed}
            </span>
          )}
        </div>

        {/* Expand toggle + detail link */}
        <div className="flex items-center gap-2 text-muted-foreground">
          <button
            onClick={e => { e.stopPropagation(); setShowModal(true); }}
            className="p-1 rounded hover:bg-muted/50 transition-colors"
            title="View full details"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
          {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </div>
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 pt-2 bg-muted/20 border-t border-border space-y-3">
              {/* Mobile counters */}
              <div className="sm:hidden grid grid-cols-4 gap-2 text-xs">
                <div className="text-center">
                  <div className="font-semibold">{run.processed}</div>
                  <div className="text-muted-foreground">Processed</div>
                </div>
                <div className="text-center text-emerald-600">
                  <div className="font-semibold">{run.credited}</div>
                  <div className="text-muted-foreground">Credited</div>
                </div>
                <div className="text-center text-amber-600">
                  <div className="font-semibold">{run.skipped}</div>
                  <div className="text-muted-foreground">Skipped</div>
                </div>
                <div className="text-center text-red-600">
                  <div className="font-semibold">{run.failed}</div>
                  <div className="text-muted-foreground">Failed</div>
                </div>
              </div>

              {/* Errors */}
              {hasErrors && (
                <div className="space-y-1">
                  <div className="text-xs font-semibold text-red-600 uppercase tracking-wide">Errors</div>
                  {run.errors.map((e, i) => (
                    <div key={i} className="text-xs bg-red-50 border border-red-200 rounded px-3 py-1.5 text-red-700 font-mono">
                      {e}
                    </div>
                  ))}
                </div>
              )}

              {!hasErrors && run.processed === 0 && (
                <p className="text-xs text-muted-foreground italic">No pending transactions found — nothing to reconcile.</p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Run detail modal */}
      <AnimatePresence>
        {showModal && (
          <RunDetailModal run={run} onClose={() => setShowModal(false)} />
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AdminReconciliation() {
  const [isRunning, setIsRunning] = useState(false);
  const [currentLog, setCurrentLog] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);
  const utils = trpc.useUtils();

  // Load run history from DB
  const historyQuery = trpc.admin.getReconciliationHistory.useQuery(
    { limit: 20 },
    { staleTime: 30_000 }
  );
  const history: ReconciliationRun[] = historyQuery.data ?? [];
  const lastRun = history[0] ?? null;

  // Load reconciliation alerts
  const alertsQuery = trpc.admin.getReconciliationAlerts.useQuery(undefined, {
    staleTime: 60_000,
    refetchInterval: 5 * 60_000, // refresh every 5 minutes
  });
  const alertsData = alertsQuery.data;
  const [alertsDismissed, setAlertsDismissed] = useState(false);
  const [resolvingId, setResolvingId] = useState<number | null>(null);

  const resolveAlertMutation = trpc.admin.resolveAlert.useMutation({
    onSuccess(data) {
      utils.admin.getReconciliationAlerts.invalidate();
      toast.success(`Alert #${data.id} marked as resolved.`);
      setResolvingId(null);
    },
    onError(err) {
      toast.error(`Failed to resolve alert: ${err.message}`);
      setResolvingId(null);
    },
  });

  const runMutation = trpc.admin.runReconciliation.useMutation({
    onSuccess(data) {
      // Invalidate history so the new run appears
      utils.admin.getReconciliationHistory.invalidate();
      setIsRunning(false);

      const creditedMsg = (data.credited ?? 0) > 0
        ? `${data.credited} transaction(s) credited.`
        : "No transactions credited.";

      if ((data.failed ?? 0) > 0) {
        toast.warning(`Reconciliation complete — ${data.failed} error(s). ${creditedMsg}`);
      } else {
        toast.success(`Reconciliation complete. ${creditedMsg}`);
      }

      setCurrentLog(prev => [
        ...prev,
        `[${new Date().toLocaleTimeString()}] ✓ Done — processed: ${data.processed ?? 0}, credited: ${data.credited ?? 0}, skipped: ${data.skipped ?? 0}, failed: ${data.failed ?? 0}`,
        `[${new Date().toLocaleTimeString()}] Duration: ${data.durationMs ?? 0}ms`,
      ]);
    },
    onError(err) {
      setIsRunning(false);
      toast.error(`Reconciliation failed: ${err.message}`);
      setCurrentLog(prev => [
        ...prev,
        `[${new Date().toLocaleTimeString()}] ✗ Error: ${err.message}`,
      ]);
    },
  });

  const handleRunNow = useCallback(() => {
    if (isRunning) return;
    setIsRunning(true);
    setCurrentLog([
      `[${new Date().toLocaleTimeString()}] Starting manual reconciliation...`,
      `[${new Date().toLocaleTimeString()}] Querying pending wallet transactions...`,
    ]);
    runMutation.mutate();
  }, [isRunning, runMutation]);

  // Auto-scroll log to bottom
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [currentLog]);

  // Simulate log progress while running
  useEffect(() => {
    if (!isRunning) return;
    const messages = [
      "Verifying transactions with payment providers...",
      "Matching transactions to wallet accounts...",
      "Crediting matched wallets...",
      "Emitting WebSocket notifications...",
    ];
    let i = 0;
    const interval = setInterval(() => {
      if (i < messages.length) {
        setCurrentLog(prev => [
          ...prev,
          `[${new Date().toLocaleTimeString()}] ${messages[i]}`,
        ]);
        i++;
      } else {
        clearInterval(interval);
      }
    }, 600);
    return () => clearInterval(interval);
  }, [isRunning]);

  // ── Aggregate stats from last run ──────────────────────────────────────────

  const totalCredited = history.reduce((s, r) => s + r.credited, 0);
  const totalFailed = history.reduce((s, r) => s + r.failed, 0);
  const avgDuration = history.length > 0
    ? Math.round(history.reduce((s, r) => s + r.durationMs, 0) / history.length)
    : 0;

  return (
    <PortalLayout
      title="Payment Reconciliation"
      subtitle="Match pending transactions and credit wallets"
    >
      <div className="p-6 space-y-8 max-w-5xl mx-auto">

        {/* ── Header ── */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
              Reconciliation Centre
            </h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              Nightly run at <strong>02:00 WAT</strong>. Matches unmatched top-up transactions to wallet accounts.
            </p>
          </div>

          <Button
            onClick={handleRunNow}
            disabled={isRunning}
            className="flex items-center gap-2 bg-[#1e3a5f] hover:bg-[#162d4a] text-white shadow-lg"
          >
            {isRunning ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                Running…
              </>
            ) : (
              <>
                <PlayCircle className="w-4 h-4" />
                Run Now
              </>
            )}
          </Button>
        </div>

        {/* ── Alerts banner ── */}
        {alertsData?.hasUnresolved && !alertsDismissed && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="rounded-xl border border-red-300 bg-red-50 p-4"
          >
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-lg bg-red-100 flex items-center justify-center shrink-0 mt-0.5">
                <AlertTriangle className="w-5 h-5 text-red-600" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-red-800">
                    {alertsData.totalAlerts} Unresolved Alert{alertsData.totalAlerts !== 1 ? "s" : ""}
                  </h3>
                  <button
                    onClick={() => setAlertsDismissed(true)}
                    className="text-red-400 hover:text-red-600 text-xs shrink-0"
                    aria-label="Dismiss alerts"
                  >
                    Dismiss
                  </button>
                </div>
                <div className="mt-2 space-y-2">
                  {alertsData.alerts.map(alert => (
                    <div key={alert.id} className="bg-white border border-red-200 rounded-lg px-3 py-2 text-xs space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <span className="font-medium text-red-700">{alert.reason}</span>
                          <span className="text-muted-foreground ml-2 shrink-0">
                            {new Date(alert.startedAt).toLocaleString("en-NG", {
                              day: "numeric", month: "short",
                              hour: "2-digit", minute: "2-digit",
                            })}
                          </span>
                        </div>
                        <button
                          onClick={() => {
                            setResolvingId(alert.id as number);
                            resolveAlertMutation.mutate({ id: alert.id as number });
                          }}
                          disabled={resolvingId === alert.id || resolveAlertMutation.isPending}
                          className="shrink-0 text-xs px-2 py-0.5 rounded border border-red-300 text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {resolvingId === alert.id ? "Resolving…" : "Resolve"}
                        </button>
                      </div>
                      {alert.errors.length > 0 && (
                        <div className="text-red-600 font-mono truncate">
                          {alert.errors[0]}
                          {alert.errors.length > 1 && ` (+${alert.errors.length - 1} more)`}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                {alertsData.totalAlerts > alertsData.alerts.length && (
                  <p className="text-xs text-red-600 mt-2">
                    Showing {alertsData.alerts.length} of {alertsData.totalAlerts} alerts. Scroll history below for full details.
                  </p>
                )}
              </div>
            </div>
          </motion.div>
        )}

        {/* ── Last run banner ── */}
        {lastRun ? (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            className={cn(
              "rounded-xl border p-4 flex flex-col sm:flex-row sm:items-center gap-3",
              lastRun.failed > 0
                ? "bg-red-50 border-red-200"
                : lastRun.credited > 0
                  ? "bg-emerald-50 border-emerald-200"
                  : "bg-slate-50 border-slate-200"
            )}
          >
            <div className={cn(
              "w-10 h-10 rounded-full flex items-center justify-center shrink-0",
              lastRun.failed > 0
                ? "bg-red-100"
                : lastRun.credited > 0
                  ? "bg-emerald-100"
                  : "bg-slate-100"
            )}>
              {lastRun.failed > 0
                ? <AlertTriangle className="w-5 h-5 text-red-600" />
                : lastRun.credited > 0
                  ? <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                  : <Clock className="w-5 h-5 text-slate-500" />
              }
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-foreground">
                Last run: {new Date(lastRun.startedAt).toLocaleString("en-NG", {
                  day: "numeric", month: "short", year: "numeric",
                  hour: "2-digit", minute: "2-digit",
                })}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {lastRun.processed} processed · {lastRun.credited} credited · {lastRun.skipped} skipped
                {lastRun.failed > 0 && ` · ${lastRun.failed} failed`}
                {" · "}
                {lastRun.durationMs < 1000
                  ? `${lastRun.durationMs}ms`
                  : `${(lastRun.durationMs / 1000).toFixed(1)}s`}
                {" · "}
                {lastRun.triggeredBy === "manual" ? "Manual trigger" : "Scheduled"}
              </div>
            </div>
          </motion.div>
        ) : (
          <div className="rounded-xl border border-dashed border-border p-6 text-center text-muted-foreground text-sm">
            No reconciliation runs recorded yet. Click <strong>Run Now</strong> to start the first run.
          </div>
        )}

        {/* ── Aggregate stats ── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            label="Total Runs"
            value={history.length}
            icon={History}
            color="text-blue-600"
            bg="bg-blue-50"
            description="All-time manual + scheduled"
          />
          <StatCard
            label="Total Credited"
            value={totalCredited}
            icon={TrendingUp}
            color="text-emerald-600"
            bg="bg-emerald-50"
            description="Transactions successfully matched"
          />
          <StatCard
            label="Total Failed"
            value={totalFailed}
            icon={XCircle}
            color={totalFailed > 0 ? "text-red-600" : "text-slate-400"}
            bg={totalFailed > 0 ? "bg-red-50" : "bg-slate-50"}
            description="Transactions that could not be matched"
          />
          <StatCard
            label="Avg Duration"
            value={avgDuration > 0 ? `${avgDuration}ms` : "—"}
            icon={Zap}
            color="text-amber-600"
            bg="bg-amber-50"
            description="Average time per run"
          />
        </div>

        {/* ── Live activity log ── */}
        <AnimatePresence>
          {(isRunning || currentLog.length > 0) && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="rounded-xl border border-border overflow-hidden"
            >
              <div className="flex items-center justify-between px-4 py-3 bg-[#1e3a5f] text-white">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Activity className="w-4 h-4" />
                  Activity Log
                </div>
                {isRunning && (
                  <div className="flex items-center gap-1.5 text-xs text-emerald-300">
                    <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse" />
                    Running
                  </div>
                )}
              </div>
              <div
                ref={logRef}
                className="bg-slate-950 text-slate-300 font-mono text-xs p-4 max-h-48 overflow-y-auto space-y-1"
              >
                {currentLog.map((line, i) => (
                  <div key={i} className={cn(
                    line.includes("✓") ? "text-emerald-400" :
                    line.includes("✗") ? "text-red-400" :
                    line.includes("Error") ? "text-red-400" :
                    "text-slate-300"
                  )}>
                    {line}
                  </div>
                ))}
                {isRunning && (
                  <div className="text-slate-500 animate-pulse">▌</div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Run history ── */}
        <div>
          <div className="flex items-center gap-2 mb-4">
            <History className="w-4 h-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
              Run History
            </h3>
            <span className="text-xs text-muted-foreground">
              {historyQuery.isLoading ? "Loading…" : `${history.length} runs from database`}
            </span>
          </div>

          {historyQuery.isLoading ? (
            <div className="rounded-xl border border-dashed border-border p-8 text-center">
              <RefreshCw className="w-6 h-6 text-muted-foreground/40 mx-auto mb-2 animate-spin" />
              <p className="text-sm text-muted-foreground">Loading history from database…</p>
            </div>
          ) : history.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-8 text-center">
              <History className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No run history yet.</p>
              <p className="text-xs text-muted-foreground mt-1">History is persisted in PostgreSQL across all sessions.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {history.map((run, i) => (
                <RunRow key={run.id} run={run} index={i} />
              ))}
            </div>
          )}
        </div>

        {/* ── Schedule info ── */}
        <div className="rounded-xl border border-border bg-white p-5">
          <h3 className="text-sm font-semibold text-foreground mb-3" style={{ fontFamily: "Sora, sans-serif" }}>
            Schedule Configuration
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
            <div>
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Scheduled Time</div>
              <div className="font-semibold text-foreground">02:00 WAT (01:00 UTC)</div>
            </div>
            <div>
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Frequency</div>
              <div className="font-semibold text-foreground">Daily (every 24 hours)</div>
            </div>
            <div>
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Batch Limit</div>
              <div className="font-semibold text-foreground">100 transactions per run</div>
            </div>
          </div>
          <div className="mt-4 pt-4 border-t border-border">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">What this job does</div>
            <ol className="text-sm text-muted-foreground space-y-1 list-decimal list-inside">
              <li>Finds wallet top-up transactions with status <code className="bg-muted px-1 rounded text-xs">(pending)</code> older than 5 minutes</li>
              <li>Verifies each transaction with the payment provider (Paystack / Flutterwave / Interswitch)</li>
              <li>Credits the matching wallet account and marks the transaction as <code className="bg-muted px-1 rounded text-xs">(reconciled)</code></li>
              <li>Emits a WebSocket event so the user's wallet page updates in real time</li>
              <li>Sends an owner notification if any transactions were credited or failed</li>
            </ol>
          </div>
        </div>

      </div>
    </PortalLayout>
  );
}
