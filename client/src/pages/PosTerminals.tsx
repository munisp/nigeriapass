/**
 * POS Terminals — /portal/pos
 * ====================================================
 * Registry of roadside POS terminals (Paystack / Flutterwave / Interswitch /
 * Moniepoint), their transactions, and a daily settlement summary.
 *
 * Data source: trpc.pos.*
 */
import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  CreditCard, Plus, Search, Loader2, RefreshCw, CheckCircle2, PauseCircle,
  Ban, AlertTriangle, ChevronLeft, ChevronRight, TrendingUp, Receipt,
  XCircle, Wallet, ArrowUpCircle, Store,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import PortalLayout from "@/components/PortalLayout";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";

// ── Types / constants ─────────────────────────────────────────────────────────
type Vendor = "paystack" | "flutterwave" | "interswitch" | "moniepoint";
type TerminalStatus = "active" | "inactive" | "maintenance" | "revoked";
type TxnStatus = "pending" | "approved" | "declined" | "reversed" | "queued_offline";
type TxnType = "toll_payment" | "wallet_topup";

const VENDORS: { value: Vendor; label: string; cls: string }[] = [
  { value: "paystack", label: "Paystack", cls: "bg-sky-50 text-sky-700 border-sky-200" },
  { value: "flutterwave", label: "Flutterwave", cls: "bg-orange-50 text-orange-700 border-orange-200" },
  { value: "interswitch", label: "Interswitch", cls: "bg-blue-50 text-blue-700 border-blue-200" },
  { value: "moniepoint", label: "Moniepoint", cls: "bg-violet-50 text-violet-700 border-violet-200" },
];

const TERMINAL_STATUS_DOT: Record<string, string> = {
  active: "bg-emerald-500",
  inactive: "bg-slate-400",
  maintenance: "bg-amber-500",
  revoked: "bg-red-500",
};

const TXN_STATUS_STYLES: Record<string, string> = {
  approved: "bg-emerald-50 text-emerald-700 border-emerald-200",
  pending: "bg-amber-50 text-amber-700 border-amber-200",
  declined: "bg-red-50 text-red-700 border-red-200",
  reversed: "bg-violet-50 text-violet-700 border-violet-200",
  queued_offline: "bg-slate-100 text-slate-600 border-slate-200",
};

const PAGE_SIZE = 25;

// ── Helpers (local to this page) ──────────────────────────────────────────────
const naira = new Intl.NumberFormat("en-NG", {
  style: "currency", currency: "NGN", maximumFractionDigits: 2,
});
const fmtNaira = (kobo: number | null | undefined) => naira.format((kobo ?? 0) / 100);

function relativeTime(d: string | Date | null | undefined) {
  if (!d) return "never";
  const diff = Date.now() - new Date(d).getTime();
  if (diff < 0) return "just now";
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}

function fmtDateTime(d: string | Date | null | undefined) {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-NG", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

function vendorMeta(v: string) {
  return VENDORS.find(x => x.value === v) ?? { value: v, label: v, cls: "bg-muted text-muted-foreground border-border" };
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function PosTerminals() {
  const utils = trpc.useUtils();
  const [tab, setTab] = useState<"terminals" | "transactions">("terminals");

  // Terminal list state
  const [tSearch, setTSearch] = useState("");
  const [tStatus, setTStatus] = useState<string>("all");
  const [tPage, setTPage] = useState(0);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ terminalId: string; action: "deactivate" | "maintenance" | "reactivate" | "revoke" } | null>(null);

  // Register form
  const [regTerminalId, setRegTerminalId] = useState("");
  const [regPlazaId, setRegPlazaId] = useState("");
  const [regVendor, setRegVendor] = useState<Vendor>("paystack");
  const [regSerial, setRegSerial] = useState("");

  // Transaction filters
  const [xType, setXType] = useState<string>("all");
  const [xStatus, setXStatus] = useState<string>("all");
  const [xTerminal, setXTerminal] = useState("");
  const [xDateFrom, setXDateFrom] = useState("");
  const [xDateTo, setXDateTo] = useState("");
  const [xPage, setXPage] = useState(0);

  useEffect(() => { setXPage(0); }, [xType, xStatus, xTerminal, xDateFrom, xDateTo]);
  useEffect(() => { setTPage(0); }, [tSearch, tStatus]);

  // ── Queries (pos router paginates by limit/offset) ───────────────────────
  const terminalsQuery = trpc.pos.listTerminals.useQuery({
    limit: PAGE_SIZE,
    offset: tPage * PAGE_SIZE,
    status: tStatus === "all" ? undefined : (tStatus as TerminalStatus),
  });
  const txnsQuery = trpc.pos.listTransactions.useQuery({
    limit: PAGE_SIZE,
    offset: xPage * PAGE_SIZE,
    type: xType === "all" ? undefined : (xType as TxnType),
    status: xStatus === "all" ? undefined : (xStatus as TxnStatus),
    terminalId: xTerminal.trim() || undefined,
    from: xDateFrom ? new Date(`${xDateFrom}T00:00:00Z`) : undefined,
    to: xDateTo ? new Date(`${xDateTo}T23:59:59Z`) : undefined,
  });
  const summaryQuery = trpc.pos.terminalDailySummary.useQuery({});

  // ── Mutations ─────────────────────────────────────────────────────────────
  const registerMutation = trpc.pos.registerTerminal.useMutation({
    onSuccess: () => {
      toast.success(`Terminal ${regTerminalId} registered`);
      setRegisterOpen(false);
      setRegTerminalId(""); setRegPlazaId(""); setRegSerial("");
      utils.pos.listTerminals.invalidate();
    },
    onError: (err) => toast.error(`Registration failed: ${err.message}`),
  });

  const updateMutation = trpc.pos.updateTerminal.useMutation({
    onSuccess: () => {
      toast.success("Terminal updated");
      setConfirm(null);
      utils.pos.listTerminals.invalidate();
      utils.pos.terminalDailySummary.invalidate();
    },
    onError: (err) => toast.error(`Update failed: ${err.message}`),
  });

  const revokeMutation = trpc.pos.revokeTerminal.useMutation({
    onSuccess: () => {
      toast.success("Terminal revoked");
      setConfirm(null);
      utils.pos.listTerminals.invalidate();
      utils.pos.terminalDailySummary.invalidate();
    },
    onError: (err) => toast.error(`Revoke failed: ${err.message}`),
  });

  // ── Derived ───────────────────────────────────────────────────────────────
  const terminals = useMemo(() => {
    const rows = terminalsQuery.data?.items ?? [];
    const q = tSearch.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(t =>
      t.terminalId.toLowerCase().includes(q) ||
      (t.serialNumber ?? "").toLowerCase().includes(q) ||
      String(t.plazaId).toLowerCase().includes(q)
    );
  }, [terminalsQuery.data, tSearch]);

  const tTotal = terminalsQuery.data?.total ?? 0;
  const tTotalPages = Math.max(1, Math.ceil(tTotal / PAGE_SIZE));
  const xTotal = txnsQuery.data?.total ?? 0;
  const xTotalPages = Math.max(1, Math.ceil(xTotal / PAGE_SIZE));

  // terminalDailySummary → { date, terminals: [{ terminalId, plazaId, totalCount,
  //   totalKobo, byType: {t:{count,totalKobo}}, byStatus: {s:{count,totalKobo}} }] }
  const summary = useMemo(() =>
    (summaryQuery.data?.terminals ?? []).map(t => ({
      terminalId: t.terminalId ?? "unknown",
      plazaId: t.plazaId ?? "—",
      txnCount: t.totalCount,
      approvedKobo: t.byStatus?.approved?.totalKobo ?? 0,
      declinedCount: t.byStatus?.declined?.count ?? 0,
      tollKobo: t.byType?.toll_payment?.totalKobo ?? 0,
      topupsKobo: t.byType?.wallet_topup?.totalKobo ?? 0,
    })),
  [summaryQuery.data]);

  const dailyTotals = useMemo(() => {
    const approvedKobo = summary.reduce((s, r) => s + r.approvedKobo, 0);
    const txnCount = summary.reduce((s, r) => s + r.txnCount, 0);
    const declined = summary.reduce((s, r) => s + r.declinedCount, 0);
    const declineRate = txnCount > 0 ? (declined / txnCount) * 100 : 0;
    return { approvedKobo, txnCount, declineRate };
  }, [summary]);

  const confirmMeta = {
    deactivate: { title: "Deactivate terminal", body: "The terminal will stop accepting new transactions until reactivated.", cta: "Deactivate", cls: "bg-amber-500 hover:bg-amber-600", icon: PauseCircle },
    maintenance: { title: "Set maintenance mode", body: "The terminal will be flagged for maintenance. Field staff will be notified.", cta: "Set Maintenance", cls: "bg-blue-600 hover:bg-blue-700", icon: RefreshCw },
    reactivate: { title: "Reactivate terminal", body: "The terminal will resume accepting transactions.", cta: "Reactivate", cls: "bg-emerald-600 hover:bg-emerald-700", icon: CheckCircle2 },
    revoke: { title: "Revoke terminal", body: "The terminal's credentials will be permanently invalidated. This cannot be undone.", cta: "Revoke", cls: "bg-red-600 hover:bg-red-700", icon: Ban },
  } as const;

  const actionPending = updateMutation.isPending || revokeMutation.isPending;

  const handleConfirm = () => {
    if (!confirm) return;
    if (confirm.action === "revoke") {
      revokeMutation.mutate({ terminalId: confirm.terminalId });
    } else {
      const status: TerminalStatus = confirm.action === "deactivate" ? "inactive"
        : confirm.action === "maintenance" ? "maintenance" : "active";
      updateMutation.mutate({ terminalId: confirm.terminalId, status });
    }
  };

  return (
    <PortalLayout title="POS Terminals" subtitle="Terminal registry, transactions and daily settlement">
      <div className="p-4 md:p-6 lg:p-8 space-y-6">

        {/* Daily summary cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {[
            { label: "Approved Today", value: fmtNaira(dailyTotals.approvedKobo), icon: TrendingUp, iconCls: "bg-emerald-100 text-emerald-600" },
            { label: "Transactions Today", value: dailyTotals.txnCount.toLocaleString(), icon: Receipt, iconCls: "bg-sky-100 text-sky-600" },
            { label: "Decline Rate", value: `${dailyTotals.declineRate.toFixed(1)}%`, icon: XCircle, iconCls: dailyTotals.declineRate > 10 ? "bg-red-100 text-red-600" : "bg-amber-100 text-amber-600" },
          ].map(s => (
            <motion.div key={s.label} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
              className="bg-white rounded-2xl border border-border p-4 md:p-5 shadow-sm">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-muted-foreground">{s.label}</span>
                <div className={cn("w-9 h-9 rounded-lg flex items-center justify-center", s.iconCls)}>
                  <s.icon className="w-4 h-4" />
                </div>
              </div>
              <div className="text-2xl font-bold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
                {summaryQuery.isLoading ? "…" : s.value}
              </div>
            </motion.div>
          ))}
        </div>

        {/* Per-terminal daily summary strip */}
        {summary.length > 0 && (
          <div className="bg-white rounded-2xl border border-border shadow-sm p-4 md:p-5">
            <div className="flex items-center gap-2 mb-3">
              <Store className="w-4 h-4 text-primary" />
              <h3 className="font-semibold text-sm" style={{ fontFamily: "Sora, sans-serif" }}>Per-Terminal Today</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[640px]">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b border-border">
                    <th className="px-3 py-2 font-medium">Terminal</th>
                    <th className="px-3 py-2 font-medium">Plaza</th>
                    <th className="px-3 py-2 font-medium text-right">Txns</th>
                    <th className="px-3 py-2 font-medium text-right">Approved</th>
                    <th className="px-3 py-2 font-medium text-right">Declined</th>
                    <th className="px-3 py-2 font-medium text-right">Tolls</th>
                    <th className="px-3 py-2 font-medium text-right">Top-ups</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {summary.map(r => (
                    <tr key={r.terminalId} className="hover:bg-muted/30">
                      <td className="px-3 py-2 font-mono text-xs font-semibold">{r.terminalId}</td>
                      <td className="px-3 py-2 text-xs">{r.plazaId}</td>
                      <td className="px-3 py-2 text-xs text-right">{r.txnCount}</td>
                      <td className="px-3 py-2 text-xs text-right font-semibold text-emerald-700">{fmtNaira(r.approvedKobo)}</td>
                      <td className={cn("px-3 py-2 text-xs text-right", r.declinedCount > 0 ? "text-red-600 font-medium" : "text-muted-foreground")}>{r.declinedCount}</td>
                      <td className="px-3 py-2 text-xs text-right">{fmtNaira(r.tollKobo)}</td>
                      <td className="px-3 py-2 text-xs text-right">{fmtNaira(r.topupsKobo)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-1.5">
          {([
            { id: "terminals", label: "Terminal Registry", icon: CreditCard },
            { id: "transactions", label: "Transactions", icon: Receipt },
          ] as const).map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={cn("px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-1.5",
                tab === t.id ? "bg-primary text-primary-foreground" : "bg-white border border-border text-muted-foreground hover:bg-muted/60")}>
              <t.icon className="w-4 h-4" /> {t.label}
            </button>
          ))}
        </div>

        {/* ── Terminals tab ── */}
        {tab === "terminals" && (
          <div className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
            <div className="p-4 border-b border-border flex items-center gap-3 flex-wrap">
              <div className="relative flex-1 min-w-48">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input value={tSearch} onChange={e => setTSearch(e.target.value)}
                  placeholder="Search terminal ID, serial, plaza…" className="pl-9 h-9" />
              </div>
              <div className="flex gap-1.5 flex-wrap">
                {["all", "active", "inactive", "maintenance", "revoked"].map(s => (
                  <button key={s} onClick={() => setTStatus(s)}
                    className={cn("px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-all",
                      tStatus === s ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/80")}>
                    {s}
                  </button>
                ))}
              </div>
              <Button size="sm" variant="outline" className="h-9 w-9 p-0" onClick={() => terminalsQuery.refetch()}
                disabled={terminalsQuery.isFetching} title="Refresh">
                <RefreshCw className={cn("w-4 h-4", terminalsQuery.isFetching && "animate-spin")} />
              </Button>
              <Button size="sm" className="h-9 gap-1.5 bg-emerald-600 hover:bg-emerald-700" onClick={() => setRegisterOpen(true)}>
                <Plus className="w-4 h-4" /> Register Terminal
              </Button>
            </div>

            {terminalsQuery.error && (
              <div className="p-4">
                <Alert variant="destructive">
                  <AlertTriangle className="w-4 h-4" />
                  <AlertTitle>Failed to load terminals</AlertTitle>
                  <AlertDescription>{terminalsQuery.error.message}</AlertDescription>
                </Alert>
              </div>
            )}

            {terminalsQuery.isLoading ? (
              <div className="p-12 flex items-center justify-center gap-2 text-muted-foreground">
                <Loader2 className="w-5 h-5 animate-spin" /><span className="text-sm">Loading terminals…</span>
              </div>
            ) : terminals.length === 0 && !terminalsQuery.error ? (
              <div className="p-12 text-center text-muted-foreground">
                <CreditCard className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p className="text-sm">{tSearch ? "No terminals match your search" : "No terminals registered yet"}</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[720px]">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground border-b border-border bg-muted/40">
                      <th className="px-4 py-2.5 font-medium">Terminal ID</th>
                      <th className="px-4 py-2.5 font-medium">Vendor</th>
                      <th className="px-4 py-2.5 font-medium">Plaza</th>
                      <th className="px-4 py-2.5 font-medium">Serial</th>
                      <th className="px-4 py-2.5 font-medium">Status</th>
                      <th className="px-4 py-2.5 font-medium">Last Seen</th>
                      <th className="px-4 py-2.5 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {terminals.map(t => {
                      const v = vendorMeta(t.vendor);
                      return (
                        <tr key={t.id} className="hover:bg-muted/30 transition-colors">
                          <td className="px-4 py-3 font-mono text-xs font-semibold">{t.terminalId}</td>
                          <td className="px-4 py-3">
                            <span className={cn("text-[10px] px-2 py-0.5 rounded-full border font-medium", v.cls)}>{v.label}</span>
                          </td>
                          <td className="px-4 py-3 text-xs">{t.plazaId}</td>
                          <td className="px-4 py-3 text-xs text-muted-foreground font-mono">{t.serialNumber ?? "—"}</td>
                          <td className="px-4 py-3">
                            <span className="inline-flex items-center gap-1.5 text-xs capitalize">
                              <span className={cn("w-2 h-2 rounded-full", TERMINAL_STATUS_DOT[t.status] ?? "bg-slate-400")} />
                              {t.status}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-xs text-muted-foreground">{relativeTime(t.lastSeenAt)}</td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1 justify-end">
                              {t.status === "active" && (
                                <>
                                  <Button size="sm" variant="ghost" title="Deactivate"
                                    className="h-7 w-7 p-0 text-amber-600 hover:bg-amber-50"
                                    onClick={() => setConfirm({ terminalId: t.terminalId, action: "deactivate" })}>
                                    <PauseCircle className="w-3.5 h-3.5" />
                                  </Button>
                                  <Button size="sm" variant="ghost" title="Maintenance"
                                    className="h-7 w-7 p-0 text-blue-600 hover:bg-blue-50"
                                    onClick={() => setConfirm({ terminalId: t.terminalId, action: "maintenance" })}>
                                    <RefreshCw className="w-3.5 h-3.5" />
                                  </Button>
                                </>
                              )}
                              {(t.status === "inactive" || t.status === "maintenance") && (
                                <Button size="sm" variant="ghost" title="Reactivate"
                                  className="h-7 w-7 p-0 text-emerald-600 hover:bg-emerald-50"
                                  onClick={() => setConfirm({ terminalId: t.terminalId, action: "reactivate" })}>
                                  <CheckCircle2 className="w-3.5 h-3.5" />
                                </Button>
                              )}
                              {t.status !== "revoked" && (
                                <Button size="sm" variant="ghost" title="Revoke"
                                  className="h-7 w-7 p-0 text-red-500 hover:bg-red-50"
                                  onClick={() => setConfirm({ terminalId: t.terminalId, action: "revoke" })}>
                                  <Ban className="w-3.5 h-3.5" />
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {tTotal > PAGE_SIZE && (
              <div className="p-3 border-t border-border flex items-center justify-between text-xs text-muted-foreground">
                <span>Page {tPage + 1} of {tTotalPages} · {tTotal.toLocaleString()} terminals</span>
                <div className="flex gap-1.5">
                  <Button size="sm" variant="outline" className="h-7 w-7 p-0" disabled={tPage === 0} onClick={() => setTPage(p => p - 1)}>
                    <ChevronLeft className="w-3.5 h-3.5" />
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 w-7 p-0" disabled={tPage + 1 >= tTotalPages} onClick={() => setTPage(p => p + 1)}>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Transactions tab ── */}
        {tab === "transactions" && (
          <div className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
            <div className="p-4 border-b border-border flex items-center gap-2.5 flex-wrap">
              <Select value={xType} onValueChange={setXType}>
                <SelectTrigger className="h-9 w-40"><SelectValue placeholder="Type" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All types</SelectItem>
                  <SelectItem value="toll_payment">Toll payment</SelectItem>
                  <SelectItem value="wallet_topup">Wallet top-up</SelectItem>
                </SelectContent>
              </Select>
              <Select value={xStatus} onValueChange={setXStatus}>
                <SelectTrigger className="h-9 w-44"><SelectValue placeholder="Status" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="approved">Approved</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="declined">Declined</SelectItem>
                  <SelectItem value="reversed">Reversed</SelectItem>
                  <SelectItem value="queued_offline">Queued offline</SelectItem>
                </SelectContent>
              </Select>
              <Input value={xTerminal} onChange={e => setXTerminal(e.target.value)}
                placeholder="Terminal ID…" className="h-9 w-40 font-mono" />
              <div className="flex items-center gap-1.5">
                <Input type="date" value={xDateFrom} onChange={e => setXDateFrom(e.target.value)} className="h-9 w-36" />
                <span className="text-xs text-muted-foreground">to</span>
                <Input type="date" value={xDateTo} onChange={e => setXDateTo(e.target.value)} className="h-9 w-36" />
              </div>
              <Button size="sm" variant="outline" className="h-9 w-9 p-0" onClick={() => txnsQuery.refetch()}
                disabled={txnsQuery.isFetching} title="Refresh">
                <RefreshCw className={cn("w-4 h-4", txnsQuery.isFetching && "animate-spin")} />
              </Button>
            </div>

            {txnsQuery.error && (
              <div className="p-4">
                <Alert variant="destructive">
                  <AlertTriangle className="w-4 h-4" />
                  <AlertTitle>Failed to load transactions</AlertTitle>
                  <AlertDescription>{txnsQuery.error.message}</AlertDescription>
                </Alert>
              </div>
            )}

            {txnsQuery.isLoading ? (
              <div className="p-12 flex items-center justify-center gap-2 text-muted-foreground">
                <Loader2 className="w-5 h-5 animate-spin" /><span className="text-sm">Loading transactions…</span>
              </div>
            ) : (txnsQuery.data?.items ?? []).length === 0 && !txnsQuery.error ? (
              <div className="p-12 text-center text-muted-foreground">
                <Receipt className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p className="text-sm">No transactions match the current filters</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[840px]">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground border-b border-border bg-muted/40">
                      <th className="px-4 py-2.5 font-medium">Time</th>
                      <th className="px-4 py-2.5 font-medium">Terminal</th>
                      <th className="px-4 py-2.5 font-medium">Type</th>
                      <th className="px-4 py-2.5 font-medium text-right">Amount</th>
                      <th className="px-4 py-2.5 font-medium">Card</th>
                      <th className="px-4 py-2.5 font-medium">RRN</th>
                      <th className="px-4 py-2.5 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {(txnsQuery.data?.items ?? []).map(row => {
                      // listTransactions returns joined rows: { txn, terminalId, plazaId }
                      const x = row.txn;
                      return (
                      <tr key={x.id} className="hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">{fmtDateTime(x.occurredAt)}</td>
                        <td className="px-4 py-3 font-mono text-xs font-semibold">{row.terminalId ?? `#${x.terminalId}`}</td>
                        <td className="px-4 py-3">
                          <Badge variant="outline" className="gap-1 text-[10px] font-medium">
                            {x.type === "wallet_topup"
                              ? <><ArrowUpCircle className="w-3 h-3 text-sky-600" /> Top-up</>
                              : <><Wallet className="w-3 h-3 text-emerald-600" /> Toll</>}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-xs text-right font-semibold">{fmtNaira(x.amountKobo)}</td>
                        <td className="px-4 py-3 text-xs">
                          {x.cardLast4
                            ? <span className="font-mono">•••• {x.cardLast4}{x.cardScheme ? <span className="text-muted-foreground"> · {x.cardScheme}</span> : null}</span>
                            : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-4 py-3 text-xs font-mono text-muted-foreground">{x.rrn ?? "—"}</td>
                        <td className="px-4 py-3">
                          <span className={cn("text-[10px] px-2 py-0.5 rounded-full border font-medium capitalize",
                            TXN_STATUS_STYLES[x.status] ?? "bg-muted text-muted-foreground border-border")}>
                            {x.status.replace(/_/g, " ")}
                          </span>
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {xTotal > PAGE_SIZE && (
              <div className="p-3 border-t border-border flex items-center justify-between text-xs text-muted-foreground">
                <span>Page {xPage + 1} of {xTotalPages} · {xTotal.toLocaleString()} transactions</span>
                <div className="flex gap-1.5">
                  <Button size="sm" variant="outline" className="h-7 w-7 p-0" disabled={xPage === 0} onClick={() => setXPage(p => p - 1)}>
                    <ChevronLeft className="w-3.5 h-3.5" />
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 w-7 p-0" disabled={xPage + 1 >= xTotalPages} onClick={() => setXPage(p => p + 1)}>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Register terminal dialog ── */}
      <Dialog open={registerOpen} onOpenChange={setRegisterOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Register Terminal</DialogTitle>
            <DialogDescription>
              Enrol a new POS terminal against a plaza. The vendor determines settlement routing.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="reg-tid" className="text-xs">Terminal ID</Label>
                <Input id="reg-tid" value={regTerminalId} onChange={e => setRegTerminalId(e.target.value.trim())}
                  placeholder="e.g. 2LAG0001" className="font-mono" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="reg-plaza" className="text-xs">Plaza ID</Label>
                <Input id="reg-plaza" value={regPlazaId} onChange={e => setRegPlazaId(e.target.value)}
                  placeholder="e.g. lekki-1" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Vendor</Label>
              <Select value={regVendor} onValueChange={v => setRegVendor(v as Vendor)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {VENDORS.map(v => <SelectItem key={v.value} value={v.value}>{v.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="reg-serial" className="text-xs">Serial Number (optional)</Label>
              <Input id="reg-serial" value={regSerial} onChange={e => setRegSerial(e.target.value)}
                placeholder="Device serial" className="font-mono" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRegisterOpen(false)}>Cancel</Button>
            <Button className="bg-emerald-600 hover:bg-emerald-700 gap-1.5"
              disabled={!regTerminalId || !regPlazaId || registerMutation.isPending}
              onClick={() => registerMutation.mutate({
                terminalId: regTerminalId,
                plazaId: regPlazaId,
                vendor: regVendor,
                serialNumber: regSerial.trim() || undefined,
              })}>
              {registerMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Register
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Confirm action dialog ── */}
      <Dialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent className="sm:max-w-sm">
          {confirm && (() => {
            const meta = confirmMeta[confirm.action];
            const Icon = meta.icon;
            return (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2">
                    <Icon className="w-5 h-5" /> {meta.title}
                  </DialogTitle>
                  <DialogDescription>{meta.body}</DialogDescription>
                </DialogHeader>
                <div className="py-2 px-3 bg-muted rounded-lg">
                  <span className="font-mono text-xs font-semibold break-all">{confirm.terminalId}</span>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setConfirm(null)}>Cancel</Button>
                  <Button className={cn("gap-1.5", meta.cls)} disabled={actionPending} onClick={handleConfirm}>
                    {actionPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Icon className="w-4 h-4" />}
                    {meta.cta}
                  </Button>
                </DialogFooter>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>
    </PortalLayout>
  );
}
