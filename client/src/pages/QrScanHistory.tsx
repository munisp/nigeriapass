/**
 * QR Scan History — Admin Page
 * Route: /portal/qr-scan-logs
 *
 * Filterable table of all gate QR scan attempts.
 * Filters: date range, device serial, valid/rejected.
 * Summary: total scans, valid, rejected, acceptance rate.
 */
import { useState, useMemo } from "react";
import { motion } from "framer-motion";
import {
  ScanLine, CheckCircle2, XCircle, Clock, Download,
  Search, Filter, RefreshCw, Shield, AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import PortalLayout from "@/components/PortalLayout";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(d: Date | string | null | undefined) {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-NG", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function AcceptanceBadge({ rate }: { rate: number }) {
  const color =
    rate >= 90 ? "bg-emerald-100 text-emerald-700 border-emerald-200" :
    rate >= 70 ? "bg-amber-100 text-amber-700 border-amber-200" :
                 "bg-red-100 text-red-700 border-red-200";
  return (
    <span className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold border", color)}>
      {rate}%
    </span>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function QrScanHistory() {
  const [serialFilter, setSerialFilter] = useState("");
  const [validFilter, setValidFilter] = useState<"all" | "valid" | "rejected">("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [limit, setLimit] = useState(100);

  // Stable query input — only recompute when filters change
  const queryInput = useMemo(() => ({
    deviceSerial: serialFilter.trim() || undefined,
    validFilter,
    fromDate: fromDate ? new Date(fromDate) : undefined,
    toDate: toDate ? new Date(toDate + "T23:59:59") : undefined,
    limit,
  }), [serialFilter, validFilter, fromDate, toDate, limit]);

  const { data, isLoading, refetch, isFetching } = trpc.devices.getQrScanHistory.useQuery(queryInput, {
    refetchInterval: 30_000,
  });

  function handleExportCsv() {
    if (!data?.logs.length) { toast.error("No data to export"); return; }
    const header = "scannedAt,deviceSerial,valid,rejectionReason,plazaName,lane,operatorName,scannedUri";
    const rows = data.logs.map(l =>
      [
        formatDate(l.scannedAt),
        l.deviceSerial,
        l.valid ? "valid" : "rejected",
        l.rejectionReason ?? "",
        l.plazaName ?? "",
        l.lane ?? "",
        l.operatorName ?? "",
        `"${l.scannedUri}"`,
      ].join(",")
    );
    const csv = [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `qr-scan-logs-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("CSV downloaded");
  }

  const logs = data?.logs ?? [];

  return (
    <PortalLayout title="QR Scan Audit Log" subtitle="Gate access attempts — all QR validations">
      {/* ── Summary cards ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        {[
          { label: "Total Scans", value: data?.totalScans ?? "—", icon: ScanLine, color: "text-sky-600", bg: "bg-sky-50" },
          { label: "Valid", value: data?.validScans ?? "—", icon: CheckCircle2, color: "text-emerald-600", bg: "bg-emerald-50" },
          { label: "Rejected", value: data?.rejectedScans ?? "—", icon: XCircle, color: "text-red-600", bg: "bg-red-50" },
          { label: "Acceptance Rate", value: data ? <AcceptanceBadge rate={data.acceptanceRate} /> : "—", icon: Shield, color: "text-violet-600", bg: "bg-violet-50" },
        ].map((card, i) => (
          <motion.div
            key={card.label}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05 }}
            className="bg-white border border-border rounded-xl p-4 flex items-center gap-3 shadow-sm"
          >
            <div className={cn("w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0", card.bg)}>
              <card.icon className={cn("w-5 h-5", card.color)} />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{card.label}</p>
              <p className="text-lg font-bold text-foreground">{card.value}</p>
            </div>
          </motion.div>
        ))}
      </div>

      {/* ── Filters ── */}
      <div className="bg-white border border-border rounded-xl p-4 mb-4 shadow-sm">
        <div className="flex flex-wrap gap-3 items-end">
          {/* Serial search */}
          <div className="flex-1 min-w-[160px]">
            <label className="text-xs text-muted-foreground mb-1 block">Device Serial</label>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="NP-NFC-LIE-001"
                value={serialFilter}
                onChange={e => setSerialFilter(e.target.value)}
                className="pl-8 h-8 text-sm"
              />
            </div>
          </div>

          {/* Valid filter */}
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Result</label>
            <div className="flex rounded-lg border border-border overflow-hidden h-8">
              {(["all", "valid", "rejected"] as const).map(f => (
                <button
                  key={f}
                  onClick={() => setValidFilter(f)}
                  className={cn(
                    "px-3 text-xs font-medium transition-colors capitalize",
                    validFilter === f
                      ? f === "valid" ? "bg-emerald-500 text-white" : f === "rejected" ? "bg-red-500 text-white" : "bg-foreground text-background"
                      : "bg-white text-muted-foreground hover:bg-muted"
                  )}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>

          {/* Date range */}
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">From</label>
            <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="h-8 text-sm w-36" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">To</label>
            <Input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="h-8 text-sm w-36" />
          </div>

          {/* Limit */}
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Limit</label>
            <select
              value={limit}
              onChange={e => setLimit(Number(e.target.value))}
              className="h-8 text-sm border border-border rounded-md px-2 bg-white"
            >
              {[50, 100, 200, 500].map(n => <option key={n} value={n}>{n} rows</option>)}
            </select>
          </div>

          {/* Actions */}
          <div className="flex gap-2 ml-auto">
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              disabled={isFetching}
              className="h-8 gap-1.5"
            >
              <RefreshCw className={cn("w-3.5 h-3.5", isFetching && "animate-spin")} />
              Refresh
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleExportCsv}
              className="h-8 gap-1.5"
            >
              <Download className="w-3.5 h-3.5" />
              CSV
            </Button>
          </div>
        </div>
      </div>

      {/* ── Table ── */}
      <div className="bg-white border border-border rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground">Time</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground">Device Serial</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground">Plaza</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground">Lane</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground">Result</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground">Reason</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground">Operator</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i} className="border-b border-border/50">
                    {Array.from({ length: 7 }).map((_, j) => (
                      <td key={j} className="px-4 py-3">
                        <div className="h-4 bg-muted rounded animate-pulse" style={{ width: `${60 + Math.random() * 30}%` }} />
                      </td>
                    ))}
                  </tr>
                ))
              ) : logs.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-16 text-center">
                    <div className="flex flex-col items-center gap-3 text-muted-foreground">
                      <ScanLine className="w-10 h-10 opacity-30" />
                      <p className="text-sm font-medium">No scan records found</p>
                      <p className="text-xs">Scans will appear here once the QR Scanner is used at a gate.</p>
                    </div>
                  </td>
                </tr>
              ) : (
                logs.map((log, i) => (
                  <motion.tr
                    key={log.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: i * 0.01 }}
                    className="border-b border-border/50 hover:bg-muted/30 transition-colors"
                  >
                    <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap font-mono">
                      {formatDate(log.scannedAt)}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs font-semibold text-foreground">
                      {log.deviceSerial}
                    </td>
                    <td className="px-4 py-3 text-xs text-foreground">
                      {log.plazaName ?? <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-4 py-3 text-xs text-foreground">
                      {log.lane ?? <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      {log.valid ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-700 border border-emerald-200">
                          <CheckCircle2 className="w-3 h-3" /> Valid
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700 border border-red-200">
                          <XCircle className="w-3 h-3" /> Rejected
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {log.rejectionReason ? (
                        <span className="inline-flex items-center gap-1 text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
                          <AlertTriangle className="w-3 h-3" />
                          {log.rejectionReason}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-foreground">
                      {log.operatorName ?? <span className="text-muted-foreground">anonymous</span>}
                    </td>
                  </motion.tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {logs.length > 0 && (
          <div className="px-4 py-2.5 border-t border-border bg-muted/20 flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              Showing <span className="font-semibold text-foreground">{logs.length}</span> of up to {limit} records
            </p>
            <div className="flex items-center gap-2">
              <Clock className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Auto-refreshes every 30s</span>
            </div>
          </div>
        )}
      </div>
    </PortalLayout>
  );
}
