/**
 * NigerianPass Admin Analytics Dashboard
 * Design: Premium Civic — Navy authority base, Sora + Nunito Sans
 *
 * Charts:
 *  - Daily KYC/KYB approvals vs rejections (AreaChart, 30 days)
 *  - Rejection reasons by category (PieChart)
 *  - Application type breakdown (DonutChart)
 *  - KYC score histogram (BarChart)
 *  - Wallet top-up KPIs
 *  - Reconciliation stats
 *
 * Data source: trpc.admin.getAnalytics (PostgreSQL aggregations)
 * Falls back to demo data when DB is unavailable.
 */
import { useState, useMemo } from "react";
import { motion } from "framer-motion";
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  RadialBarChart, RadialBar,
} from "recharts";
import {
  CheckCircle2, XCircle, Clock, TrendingUp, Users, FileText,
  AlertTriangle, BarChart2, RefreshCw, Download, Wallet, RefreshCcw,
  Server, ArrowUpDown, ExternalLink, Phone, CheckCheck, Timer, Hash, Cpu,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import PortalLayout from "@/components/PortalLayout";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Link } from "wouter";

// ── Colour palette ────────────────────────────────────────────────────────────
const C = {
  approved: "#10b981",
  rejected: "#ef4444",
  pending: "#f59e0b",
  review: "#3b82f6",
  navy: "#1e3a5f",
  sky: "#0ea5e9",
  purple: "#8b5cf6",
  teal: "#14b8a6",
  orange: "#f97316",
  pink: "#ec4899",
};

const PIE_COLORS = [C.rejected, C.orange, C.pending, C.purple, C.pink, C.sky];
const TYPE_COLORS = [C.sky, C.teal, C.purple];

// ── Custom tooltip ────────────────────────────────────────────────────────────
function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border border-border rounded-xl shadow-lg p-3 text-xs">
      <div className="font-semibold text-foreground mb-1.5">{label}</div>
      {payload.map((p: any) => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ background: p.color }} />
          <span className="text-muted-foreground capitalize">{p.name}:</span>
          <span className="font-medium text-foreground">{p.value.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────
function StatCard({
  icon: Icon, label, value, sub, color, trend,
}: {
  icon: React.ElementType; label: string; value: string | number;
  sub?: string; color: string; trend?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-white rounded-2xl border border-border p-5 shadow-sm"
    >
      <div className="flex items-start justify-between mb-3">
        <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center", color)}>
          <Icon className="w-5 h-5" />
        </div>
        {trend && (
          <span className="text-xs font-medium text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">
            {trend}
          </span>
        )}
      </div>
      <div className="text-2xl font-bold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </div>
      <div className="text-sm text-muted-foreground mt-0.5">{label}</div>
      {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
    </motion.div>
  );
}

// ── Skeleton card ─────────────────────────────────────────────────────────────
function SkeletonCard({ className }: { className?: string }) {
  return (
    <div className={cn("bg-white rounded-2xl border border-border p-5 shadow-sm animate-pulse", className)}>
      <div className="h-4 bg-muted rounded w-1/3 mb-3" />
      <div className="h-8 bg-muted rounded w-1/2 mb-2" />
      <div className="h-3 bg-muted rounded w-2/3" />
    </div>
  );
}

// ── Chart card wrapper ────────────────────────────────────────────────────────
function ChartCard({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("bg-white rounded-2xl border border-border p-5 shadow-sm", className)}>
      <h3 className="font-semibold text-sm mb-4 text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
        {title}
      </h3>
      {children}
    </div>
  );
}

// ── Range selector ────────────────────────────────────────────────────────────
type Range = "7d" | "14d" | "30d";
const RANGE_DAYS: Record<Range, number> = { "7d": 7, "14d": 14, "30d": 30 };

// ── Main page ─────────────────────────────────────────────────────────────────
export default function AdminAnalytics() {
  const [range, setRange] = useState<Range>("30d");

  const { data, isLoading, refetch, isFetching } = trpc.admin.getAnalytics.useQuery(
    { days: RANGE_DAYS[range] },
    { refetchOnWindowFocus: false }
  );

  const exportCsvMutation = trpc.admin.exportAnalyticsCsv.useMutation();

  const handleExportCsv = async () => {
    try {
      const result = await exportCsvMutation.mutateAsync({ days: RANGE_DAYS[range] });
      const blob = new Blob([result.csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = result.filename;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${result.rowCount} rows${result.source === "demo" ? " (demo data)" : ""}`);
    } catch (err: unknown) {
      toast.error((err as Error)?.message ?? "Export failed");
    }
  };

  // Slice daily data to the selected range
  const rangeData = useMemo(() => {
    if (!data?.dailyData) return [];
    return data.dailyData.slice(-RANGE_DAYS[range]).map(d => ({
      ...d,
      date: d.date.slice(5), // "MM-DD" for compact x-axis labels
    }));
  }, [data, range]);

  const kpi = data?.kpi;
  const approvalRate = kpi?.approvalRate ?? 0;

  // ── Plaza Health tile ─────────────────────────────────────────────────────
  const plazaSummaryQuery = trpc.devices.plazaSummary.useQuery(undefined, {
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
  });
  const [plazaSort, setPlazaSort] = useState<"offlinePct" | "total" | "plaza">("offlinePct");
  const [plazaSortDir, setPlazaSortDir] = useState<"asc" | "desc">("desc");

  const sortedPlazas = useMemo(() => {
    const rows = (plazaSummaryQuery.data ?? []).map(r => ({
      ...r,
      offlinePct: r.total > 0 ? Math.round(((r.offline + r.warning) / r.total) * 100) : 0,
    }));
    return [...rows].sort((a, b) => {
      let diff = 0;
      if (plazaSort === "offlinePct") diff = a.offlinePct - b.offlinePct;
      else if (plazaSort === "total") diff = a.total - b.total;
      else diff = a.plaza.localeCompare(b.plaza);
      return plazaSortDir === "desc" ? -diff : diff;
    });
  }, [plazaSummaryQuery.data, plazaSort, plazaSortDir]);

  const togglePlazaSort = (col: typeof plazaSort) => {
    if (plazaSort === col) setPlazaSortDir(d => d === "desc" ? "asc" : "desc");
    else { setPlazaSort(col); setPlazaSortDir("desc"); }
  };

  // ── Firmware Version Matrix tile ─────────────────────────────────────────
  const firmwareMatrixQuery = trpc.devices.getFirmwareMatrix.useQuery(undefined, {
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
  });

  // ── USSD Session Stats tile ───────────────────────────────────────────────
  const ussdStatsQuery = trpc.ussd.getSessionStats.useQuery(
    { days: RANGE_DAYS[range] },
    { refetchInterval: 60_000, refetchOnWindowFocus: false },
  );
  const ussdStats = ussdStatsQuery.data;

  return (
    <PortalLayout title="Analytics Dashboard" subtitle="KYC/KYB application insights for compliance officers">
      <div className="p-4 md:p-6 lg:p-8 space-y-6">

        {/* ── Header actions ─────────────────────────────────────────────── */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            {(["7d", "14d", "30d"] as Range[]).map(r => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={cn(
                  "px-3 py-1.5 text-xs font-medium rounded-lg border transition-all",
                  range === r
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-white text-muted-foreground border-border hover:border-primary/50"
                )}
              >
                {r === "7d" ? "7 Days" : r === "14d" ? "14 Days" : "30 Days"}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline" size="sm" className="gap-1.5 text-xs"
              onClick={() => { refetch(); toast.info("Data refreshed"); }}
              disabled={isFetching}
            >
              <RefreshCw className={cn("w-3.5 h-3.5", isFetching && "animate-spin")} />
              Refresh
            </Button>
            <Button
              variant="outline" size="sm" className="gap-1.5 text-xs"
              onClick={handleExportCsv}
              disabled={exportCsvMutation.isPending}
            >
              <Download className="w-3.5 h-3.5" />
              {exportCsvMutation.isPending ? "Exporting..." : "Export CSV"}
            </Button>
          </div>
        </div>

        {/* ── KPI cards ──────────────────────────────────────────────────── */}
        {isLoading ? (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)}
          </div>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              icon={FileText} label="Total Applications"
              value={kpi?.totalApps ?? 0}
              sub={`Last ${RANGE_DAYS[range]} days`}
              color="bg-blue-50 text-blue-600"
            />
            <StatCard
              icon={CheckCircle2} label="Approved"
              value={kpi?.totalApproved ?? 0}
              sub={`${approvalRate}% approval rate`}
              color="bg-emerald-50 text-emerald-600"
            />
            <StatCard
              icon={XCircle} label="Rejected"
              value={kpi?.totalRejected ?? 0}
              sub="See rejection reasons below"
              color="bg-red-50 text-red-600"
            />
            <StatCard
              icon={Wallet} label="Wallet Top-ups"
              value={`₦${((kpi?.topupTotalKobo ?? 0) / 100).toLocaleString()}`}
              sub={`${kpi?.topupCount ?? 0} transactions`}
              color="bg-amber-50 text-amber-600"
            />
          </div>
        )}

        {/* ── Reconciliation KPIs ─────────────────────────────────────────── */}
        {!isLoading && kpi && (
          <div className="grid grid-cols-3 gap-4">
            <StatCard
              icon={RefreshCcw} label="Recon Runs"
              value={kpi.reconRuns}
              sub={`Last ${RANGE_DAYS[range]} days`}
              color="bg-purple-50 text-purple-600"
            />
            <StatCard
              icon={CheckCircle2} label="Credited"
              value={kpi.reconCredited}
              sub="Transactions credited"
              color="bg-emerald-50 text-emerald-600"
            />
            <StatCard
              icon={AlertTriangle} label="Recon Failures"
              value={kpi.reconFailed}
              sub="Transactions failed"
              color={kpi.reconFailed > 0 ? "bg-red-50 text-red-600" : "bg-gray-50 text-gray-400"}
            />
          </div>
        )}

        {/* ── Daily approvals area chart ──────────────────────────────────── */}
        <ChartCard title={`Daily Application Outcomes — Last ${RANGE_DAYS[range]} Days`}>
          {isLoading ? (
            <div className="h-[220px] bg-muted rounded-xl animate-pulse" />
          ) : rangeData.length === 0 ? (
            <div className="h-[220px] flex items-center justify-center text-sm text-muted-foreground">
              No application data for this period
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={rangeData} margin={{ top: 4, right: 8, bottom: 0, left: -10 }}>
                <defs>
                  <linearGradient id="gradApproved" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={C.approved} stopOpacity={0.25} />
                    <stop offset="95%" stopColor={C.approved} stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gradRejected" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={C.rejected} stopOpacity={0.2} />
                    <stop offset="95%" stopColor={C.rejected} stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gradPending" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={C.pending} stopOpacity={0.2} />
                    <stop offset="95%" stopColor={C.pending} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#94a3b8" }} tickLine={false} axisLine={false} interval={range === "7d" ? 0 : range === "14d" ? 1 : 3} />
                <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} tickLine={false} axisLine={false} />
                <Tooltip content={<CustomTooltip />} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                <Area type="monotone" dataKey="approved" stroke={C.approved} strokeWidth={2} fill="url(#gradApproved)" name="Approved" />
                <Area type="monotone" dataKey="rejected" stroke={C.rejected} strokeWidth={2} fill="url(#gradRejected)" name="Rejected" />
                <Area type="monotone" dataKey="pending" stroke={C.pending} strokeWidth={2} fill="url(#gradPending)" name="Pending" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        {/* ── Row: rejection reasons + app type ──────────────────────────── */}
        <div className="grid md:grid-cols-2 gap-4">
          <ChartCard title="Rejection Reasons">
            {isLoading ? (
              <div className="h-[180px] bg-muted rounded-xl animate-pulse" />
            ) : (
              <div className="flex items-center gap-4">
                <ResponsiveContainer width="50%" height={180}>
                  <PieChart>
                    <Pie
                      data={data?.rejectionReasons ?? []}
                      cx="50%" cy="50%"
                      innerRadius={45} outerRadius={75}
                      paddingAngle={3}
                      dataKey="value"
                    >
                      {(data?.rejectionReasons ?? []).map((_, i) => (
                        <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(v: number) => [v, "rejections"]} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="flex-1 space-y-2">
                  {(data?.rejectionReasons ?? []).map((r, i) => (
                    <div key={r.name} className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                      <span className="text-xs text-muted-foreground flex-1 truncate">{r.name}</span>
                      <span className="text-xs font-semibold text-foreground">{r.value}</span>
                    </div>
                  ))}
                  {(data?.rejectionReasons ?? []).length === 0 && (
                    <p className="text-xs text-muted-foreground">No rejections in this period</p>
                  )}
                </div>
              </div>
            )}
          </ChartCard>

          <ChartCard title="Application Type Breakdown">
            {isLoading ? (
              <div className="h-[180px] bg-muted rounded-xl animate-pulse" />
            ) : (
              <div className="flex items-center gap-4">
                <ResponsiveContainer width="50%" height={180}>
                  <PieChart>
                    <Pie
                      data={data?.appTypeData ?? []}
                      cx="50%" cy="50%"
                      innerRadius={45} outerRadius={75}
                      paddingAngle={3}
                      dataKey="value"
                    >
                      {(data?.appTypeData ?? []).map((_, i) => (
                        <Cell key={i} fill={TYPE_COLORS[i % TYPE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(v: number) => [`${v}%`, ""]} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="flex-1 space-y-3">
                  {(data?.appTypeData ?? []).map((t, i) => (
                    <div key={t.name}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs text-muted-foreground">{t.name}</span>
                        <span className="text-xs font-semibold text-foreground">{t.value}% ({t.raw})</span>
                      </div>
                      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${t.value}%`, background: TYPE_COLORS[i % TYPE_COLORS.length] }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </ChartCard>
        </div>

        {/* ── KYC score histogram ─────────────────────────────────────────── */}
        <ChartCard title="KYC Score Distribution">
          {isLoading ? (
            <div className="h-[180px] bg-muted rounded-xl animate-pulse" />
          ) : (
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={data?.kycScoreHist ?? []} margin={{ top: 4, right: 8, bottom: 0, left: -10 }} barSize={22}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                <XAxis dataKey="range" tick={{ fontSize: 10, fill: "#94a3b8" }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} tickLine={false} axisLine={false} />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="count" name="Applicants" radius={[4, 4, 0, 0]}>
                  {(data?.kycScoreHist ?? []).map((entry, i) => (
                    <Cell
                      key={i}
                      fill={entry.range.startsWith("9") || entry.range.startsWith("8") ? C.approved :
                            entry.range.startsWith("7") || entry.range.startsWith("6") ? C.sky :
                            entry.range.startsWith("4") || entry.range.startsWith("5") ? C.pending : C.rejected}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        {/* ── Plaza Device Health ──────────────────────────────────────── */}
        <ChartCard title="Plaza Device Health">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs text-muted-foreground">
              Ranked by unhealthy device percentage (offline + warning). Refreshes every 30 s.
            </p>
            <Link
              href="/devices"
              className="flex items-center gap-1 text-xs text-blue-600 hover:underline font-medium"
            >
              Manage Devices <ExternalLink className="w-3 h-3" />
            </Link>
          </div>
          {plazaSummaryQuery.isLoading ? (
            <div className="h-[200px] bg-muted rounded-xl animate-pulse" />
          ) : sortedPlazas.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
              <Server className="w-8 h-8 mb-2 opacity-30" />
              <p className="text-sm">No device data available — seed devices first</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    {([
                      { key: "plaza" as const, label: "Plaza" },
                      { key: "total" as const, label: "Total" },
                      { key: null, label: "Online" },
                      { key: null, label: "Warning" },
                      { key: null, label: "Offline" },
                      { key: "offlinePct" as const, label: "Unhealthy %" },
                      { key: null, label: "Health Bar" },
                    ]).map(col => (
                      <th
                        key={col.label}
                        className={cn(
                          "py-2 px-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide",
                          col.key && "cursor-pointer hover:text-foreground select-none"
                        )}
                        onClick={() => col.key && togglePlazaSort(col.key)}
                      >
                        <span className="flex items-center gap-1">
                          {col.label}
                          {col.key && plazaSort === col.key && (
                            <ArrowUpDown className="w-3 h-3" />
                          )}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedPlazas.map((row) => (
                    <tr key={row.plaza} className="border-b border-border/50 last:border-0 hover:bg-muted/40 transition-colors">
                      <td className="py-2.5 px-3 font-medium text-foreground">{row.plaza}</td>
                      <td className="py-2.5 px-3 text-muted-foreground">{row.total}</td>
                      <td className="py-2.5 px-3">
                        <span className="inline-flex items-center gap-1 text-emerald-600 font-medium">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                          {row.online}
                        </span>
                      </td>
                      <td className="py-2.5 px-3">
                        <span className="inline-flex items-center gap-1 text-amber-600 font-medium">
                          <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                          {row.warning}
                        </span>
                      </td>
                      <td className="py-2.5 px-3">
                        <span className="inline-flex items-center gap-1 text-red-600 font-medium">
                          <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
                          {row.offline}
                        </span>
                      </td>
                      <td className="py-2.5 px-3">
                        <span className={cn(
                          "font-bold",
                          row.offlinePct >= 50 ? "text-red-600" :
                          row.offlinePct >= 25 ? "text-amber-600" : "text-emerald-600"
                        )}>
                          {row.offlinePct}%
                        </span>
                      </td>
                      <td className="py-2.5 px-3 min-w-[120px]">
                        <div className="h-2 rounded-full bg-muted overflow-hidden flex">
                          <div
                            className="h-full bg-emerald-500"
                            style={{ width: `${row.total > 0 ? (row.online / row.total) * 100 : 0}%` }}
                          />
                          <div
                            className="h-full bg-amber-400"
                            style={{ width: `${row.total > 0 ? (row.warning / row.total) * 100 : 0}%` }}
                          />
                          <div
                            className="h-full bg-red-500"
                            style={{ width: `${row.total > 0 ? (row.offline / row.total) * 100 : 0}%` }}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </ChartCard>

        {/* ── USSD Session Analytics ─────────────────────────────────────── */}
        <ChartCard title={`USSD Session Analytics (*346#) — Last ${RANGE_DAYS[range]} Days`}>
          {ussdStatsQuery.isLoading ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 animate-pulse">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-16 bg-muted rounded-xl" />
              ))}
            </div>
          ) : (
            <div className="space-y-5">
              {/* KPI row */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[
                  { icon: Phone, label: "Total Sessions", value: (ussdStats?.totalSessions ?? 0).toLocaleString(), color: "bg-sky-50 text-sky-600" },
                  { icon: CheckCheck, label: "Completion Rate", value: `${ussdStats?.completionRate ?? 0}%`, color: "bg-emerald-50 text-emerald-600" },
                  { icon: Hash, label: "Avg Interactions", value: (ussdStats?.avgInteractions ?? 0).toFixed(1), color: "bg-violet-50 text-violet-600" },
                  { icon: Timer, label: "Avg Duration", value: ussdStats?.avgDurationSeconds != null ? `${ussdStats.avgDurationSeconds}s` : "—", color: "bg-amber-50 text-amber-600" },
                ].map(s => (
                  <div key={s.label} className="bg-muted/30 rounded-xl p-4 flex items-center gap-3">
                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${s.color}`}>
                      <s.icon className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="text-lg font-bold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>{s.value}</div>
                      <div className="text-xs text-muted-foreground">{s.label}</div>
                    </div>
                  </div>
                ))}
              </div>
              {/* Top menu paths */}
              {(ussdStats?.topMenuPaths?.length ?? 0) > 0 && (
                <div>
                  <div className="text-xs font-semibold text-muted-foreground mb-2">Top Menu Paths</div>
                  <div className="space-y-1.5">
                    {(ussdStats?.topMenuPaths ?? []).slice(0, 5).map((p, i) => {
                      const maxCount = ussdStats?.topMenuPaths?.[0]?.count ?? 1;
                      return (
                        <div key={p.path} className="flex items-center gap-3">
                          <span className="text-xs text-muted-foreground w-4 text-right">{i + 1}</span>
                          <div className="flex-1 h-5 bg-muted rounded-full overflow-hidden">
                            <div
                              className="h-full bg-sky-400 rounded-full transition-all"
                              style={{ width: `${Math.round((p.count / maxCount) * 100)}%` }}
                            />
                          </div>
                          <span className="text-xs font-mono text-foreground min-w-[60px]">{p.path}</span>
                          <span className="text-xs text-muted-foreground w-8 text-right">{p.count}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              {/* Daily bar chart */}
              {(ussdStats?.dailyCounts?.length ?? 0) > 0 && (
                <ResponsiveContainer width="100%" height={120}>
                  <BarChart data={ussdStats?.dailyCounts ?? []} barSize={10} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                    <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={d => d.slice(5)} />
                    <YAxis tick={{ fontSize: 10 }} />
                    <Tooltip content={<CustomTooltip />} />
                    <Bar dataKey="total" name="Total" fill={C.sky} radius={[3, 3, 0, 0]} />
                    <Bar dataKey="completed" name="Completed" fill={C.approved} radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
              {(ussdStats?.totalSessions ?? 0) === 0 && (
                <div className="text-center py-6 text-sm text-muted-foreground">
                  No USSD sessions recorded in the last {RANGE_DAYS[range]} days.
                  Sessions are tracked once users dial *346#.
                </div>
              )}
            </div>
          )}
        </ChartCard>

        {/* ── Firmware Version Matrix ──────────────────────────────────── */}
        <ChartCard title="Fleet Firmware Version Matrix">
          {firmwareMatrixQuery.isLoading ? (
            <div className="space-y-2 animate-pulse">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-10 bg-muted rounded-xl" />
              ))}
            </div>
          ) : (firmwareMatrixQuery.data?.length ?? 0) === 0 ? (
            <div className="text-center py-6 text-sm text-muted-foreground">
              No device firmware data available. Seed devices first.
            </div>
          ) : (
            <div className="space-y-4">
              {/* KPI row */}
              <div className="grid grid-cols-3 gap-4">
                {[
                  {
                    icon: Cpu,
                    label: "Distinct Versions",
                    value: (firmwareMatrixQuery.data?.length ?? 0).toString(),
                    color: "bg-violet-50 text-violet-600",
                  },
                  {
                    icon: CheckCheck,
                    label: "Up-to-date Devices",
                    value: (firmwareMatrixQuery.data?.find(r => r.isLatest)?.deviceCount ?? 0).toLocaleString(),
                    color: "bg-emerald-50 text-emerald-600",
                  },
                  {
                    icon: AlertTriangle,
                    label: "Outdated Devices",
                    value: (firmwareMatrixQuery.data?.filter(r => !r.isLatest).reduce((s, r) => s + r.deviceCount, 0) ?? 0).toLocaleString(),
                    color: "bg-amber-50 text-amber-600",
                  },
                ].map(s => (
                  <div key={s.label} className="bg-muted/30 rounded-xl p-4 flex items-center gap-3">
                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${s.color}`}>
                      <s.icon className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="text-lg font-bold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>{s.value}</div>
                      <div className="text-xs text-muted-foreground">{s.label}</div>
                    </div>
                  </div>
                ))}
              </div>
              {/* Stacked bar chart: version → device count */}
              <ResponsiveContainer width="100%" height={140}>
                <BarChart
                  data={firmwareMatrixQuery.data ?? []}
                  layout="vertical"
                  margin={{ top: 4, right: 16, left: 8, bottom: 4 }}
                >
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f0f0f0" />
                  <XAxis type="number" tick={{ fontSize: 10 }} />
                  <YAxis type="category" dataKey="version" tick={{ fontSize: 10 }} width={52} />
                  <Tooltip
                    content={({ active, payload, label }) => {
                      if (!active || !payload?.length) return null;
                      const row = firmwareMatrixQuery.data?.find(r => r.version === label);
                      return (
                        <div className="bg-white border border-border rounded-xl shadow-lg p-3 text-xs max-w-[220px]">
                          <div className="font-semibold mb-1">v{label} {row?.isLatest ? "✓ Latest" : "⚠ Outdated"}</div>
                          <div className="text-muted-foreground">{payload[0]?.value} device{payload[0]?.value !== 1 ? "s" : ""}</div>
                          {(row?.plazas?.length ?? 0) > 0 && (
                            <div className="mt-1 text-muted-foreground">{row?.plazas.slice(0, 3).join(", ")}{(row?.plazas.length ?? 0) > 3 ? ` +${(row?.plazas.length ?? 0) - 3} more` : ""}</div>
                          )}
                        </div>
                      );
                    }}
                  />
                  <Bar
                    dataKey="deviceCount"
                    name="Devices"
                    radius={[0, 4, 4, 0]}
                    label={{ position: "right", fontSize: 10, fill: "#6b7280" }}
                  >
                    {(firmwareMatrixQuery.data ?? []).map((entry, index) => (
                      <Cell
                        key={`cell-${index}`}
                        fill={entry.isLatest ? C.approved : C.orange}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              {/* Version list */}
              <div className="space-y-2">
                {(firmwareMatrixQuery.data ?? []).map(row => (
                  <div key={row.version} className="flex items-center gap-3 text-xs">
                    <span className={cn(
                      "inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-mono font-semibold",
                      row.isLatest ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"
                    )}>
                      {row.isLatest ? "✓" : "⚠"} v{row.version}
                    </span>
                    <span className="text-muted-foreground">{row.deviceCount} device{row.deviceCount !== 1 ? "s" : ""}</span>
                    <span className="text-muted-foreground flex-1 truncate">{row.plazas.slice(0, 2).join(", ")}{row.plazas.length > 2 ? ` +${row.plazas.length - 2}` : ""}</span>
                    <Link
                      href={`/portal/devices?firmware=${encodeURIComponent(row.version)}`}
                      className="text-primary hover:underline flex items-center gap-0.5"
                    >
                      View <ExternalLink className="w-3 h-3" />
                    </Link>
                  </div>
                ))}
              </div>
            </div>
          )}
        </ChartCard>

        {/* ── Radial approval rate ────────────────────────────────────────── */}
        <ChartCard title={`Overall Approval Rate — Last ${RANGE_DAYS[range]} Days`}>
          <div className="flex items-center gap-8">
            <ResponsiveContainer width={160} height={160}>
              <RadialBarChart
                cx="50%" cy="50%"
                innerRadius={45} outerRadius={70}
                data={[{ name: "Approved", value: approvalRate, fill: C.approved }]}
                startAngle={90} endAngle={90 - 360 * (approvalRate / 100)}
              >
                <RadialBar dataKey="value" cornerRadius={6} />
              </RadialBarChart>
            </ResponsiveContainer>
            <div className="flex-1 grid grid-cols-2 gap-4">
              {[
                { label: "Approval Rate", value: `${approvalRate}%`, color: "text-emerald-600" },
                { label: "Total Approved", value: (kpi?.totalApproved ?? 0).toLocaleString(), color: "text-blue-600" },
                { label: "Total Rejected", value: (kpi?.totalRejected ?? 0).toLocaleString(), color: "text-red-500" },
                { label: "Recon Runs", value: (kpi?.reconRuns ?? 0).toString(), color: "text-purple-600" },
              ].map(s => (
                <div key={s.label}>
                  <div className={cn("text-xl font-bold", s.color)} style={{ fontFamily: "Sora, sans-serif" }}>{s.value}</div>
                  <div className="text-xs text-muted-foreground">{s.label}</div>
                </div>
              ))}
            </div>
          </div>
        </ChartCard>

      </div>
    </PortalLayout>
  );
}
