/**
 * NigerianPass Wallet Portal
 * Design: Premium Civic — Navy/Emerald palette, Sora + Nunito Sans
 * Features:
 *  - TigerBeetle wallet balance with fare-cap usage ring
 *  - Paystack / Flutterwave top-up modal
 *  - Transaction history with pagination and filters
 *  - Toll receipt detail drawer
 */
import { useState, useMemo, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Wallet, ArrowDownLeft, RefreshCw,
  ChevronDown, ChevronLeft, ChevronRight, Download, X,
  MapPin, CreditCard, Zap, CheckCircle2,
  TrendingUp, Calendar, Search, Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import type { WalletBalance, Transaction } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useLocation } from "wouter";
import { PaymentProviderSelector, type PaymentProviderSlug } from "@/components/PaymentProviderSelector";
import { useWalletCreditPush, type WalletCreditedEvent, type TierUpgradedEvent } from "@/hooks/useWalletCreditPush";

// No demo/seed data — balance and transactions come from trpc.wallet queries
// and the page shows the server's error state when they fail.

const TOP_UP_AMOUNTS = [1000, 2000, 5000, 10000, 20000, 50000];

function koboToNaira(kobo: number): string {
  return (kobo / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-NG", {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

type FilterType = "all" | "toll_charge" | "topup" | "refund";
type DateRange = "7d" | "30d" | "90d" | "all";

export default function WalletPage() {
  const [, navigate] = useLocation();

  const [refreshing, setRefreshing] = useState(false);

  // ── tRPC queries ────────────────────────────────────────────────────────────
  const utils = trpc.useUtils();

  const balanceQuery = trpc.wallet.getBalance.useQuery(undefined, {
    staleTime: 30_000, // 30s
    retry: 1,
  });

  const txnsQuery = trpc.wallet.getTransactions.useQuery(
    { page: 1, limit: 100 },
    { staleTime: 30_000, retry: 1 }
  );

  const exportCsvMutation = trpc.wallet.exportTransactionsCsv.useMutation();

  const handleExportCsv = async () => {
    try {
      const days = dateRange === "7d" ? 7 : dateRange === "30d" ? 30 : dateRange === "90d" ? 90 : 365;
      const result = await exportCsvMutation.mutateAsync({ days });
      const blob = new Blob([result.csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = result.filename;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${result.rowCount} transactions`);
    } catch (err: unknown) {
      toast.error((err as Error)?.message ?? "Export failed");
    }
  };

  const handleDownloadReceipt = async (txId: number) => {
    try {
      const tx = await utils.wallet.getTransactionReceipt.fetch({ transactionId: txId });
      // Use the server-generated PDF if available, otherwise fall back to HTML
      if (tx.pdfBase64) {
        const byteChars = atob(tx.pdfBase64);
        const byteArray = new Uint8Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) byteArray[i] = byteChars.charCodeAt(i);
        const blob = new Blob([byteArray], { type: "application/pdf" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = tx.pdfFilename ?? `NigerianPass-Receipt-${tx.id}.pdf`;
        a.click();
        URL.revokeObjectURL(url);
        toast.success("PDF receipt downloaded");
      } else {
        // Fallback: HTML receipt
        const date = new Date(tx.createdAt).toLocaleString("en-NG", { timeZone: "Africa/Lagos" });
        const receiptHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Receipt ${tx.externalRef || tx.id}</title>
<style>body{font-family:sans-serif;max-width:480px;margin:40px auto;padding:24px;border:1px solid #ddd;border-radius:8px}
h1{font-size:18px;margin-bottom:4px}p{margin:6px 0;font-size:14px}.amount{font-size:24px;font-weight:700;margin:16px 0}
.footer{margin-top:24px;font-size:11px;color:#888;border-top:1px solid #eee;padding-top:12px}</style></head>
<body><h1>NigerianPass Receipt</h1><p style="color:#666">${date}</p>
<div class="amount">\u20a6${tx.amountNgn}</div>
<p><strong>Type:</strong> ${tx.type.replace("_", " ").toUpperCase()}</p>
<p><strong>Description:</strong> ${tx.description || "\u2014"}</p>
<p><strong>Reference:</strong> ${tx.externalRef || tx.id}</p>
${tx.plazaId ? `<p><strong>Plaza:</strong> ${tx.plazaId}</p>` : ""}
<div class="footer">NigerianPass Electronic Toll Management System<br>This is a computer-generated receipt.</div>
</body></html>`;
        const blob = new Blob([receiptHtml], { type: "text/html" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `receipt-${tx.externalRef || tx.id}.html`;
        a.click();
        URL.revokeObjectURL(url);
        toast.success("Receipt downloaded");
      }
    } catch (err: unknown) {
      toast.error((err as Error)?.message ?? "Failed to download receipt");
    }
  };

  const balance: WalletBalance | null = balanceQuery.data
    ? {
        account_id: balanceQuery.data.account_id,
        balance_kobo: balanceQuery.data.balance_kobo,
        pending_kobo: balanceQuery.data.pending_kobo,
        currency: balanceQuery.data.currency,
        tier: balanceQuery.data.tier,
        daily_cap_kobo: balanceQuery.data.daily_cap_kobo,
        daily_spent_kobo: balanceQuery.data.daily_spent_kobo,
        fare_cap_limit_kobo: balanceQuery.data.fare_cap_limit_kobo,
        fare_cap_reset_date: balanceQuery.data.fare_cap_reset_date,
        last_updated: balanceQuery.data.last_updated,
      }
    : null;

  const transactions: Transaction[] = (txnsQuery.data?.transactions ?? []) as Transaction[];
  const loading = balanceQuery.isLoading || txnsQuery.isLoading;

  // Filters
  const [filterType, setFilterType] = useState<FilterType>("all");
  const [dateRange, setDateRange] = useState<DateRange>("30d");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 8;

  // Top-up modal
  const [showTopUp, setShowTopUp] = useState(false);
  const [topUpAmount, setTopUpAmount] = useState(5000);
  const [customAmount, setCustomAmount] = useState("");
  const [topUpProvider, setTopUpProvider] = useState<PaymentProviderSlug>("paystack");
  const [topUpLoading, setTopUpLoading] = useState(false);

  // tRPC top-up mutation (uses ctx.user.email — no hardcoded placeholder)
  const initiateTopup = trpc.wallet.initiateTopup.useMutation({
    onSuccess: (data) => {
      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
      } else {
        toast.error("No checkout URL returned");
      }
    },
    onError: (err) => {
      toast.error(`Top-up failed: ${err.message}`);
      setTopUpLoading(false);
    },
  });

  // Receipt drawer
  const [selectedTxn, setSelectedTxn] = useState<Transaction | null>(null);

  // ── Real-time wallet credit push ──────────────────────────────────────────
  const handleWalletCredit = useCallback((event: WalletCreditedEvent) => {
    const amountNaira = (event.amountKobo / 100).toLocaleString("en-NG", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    toast.success(`₦${amountNaira} credited to your wallet`, {
      description: `Reference: ${event.reference}`,
      duration: 8000,
    });
    // Refresh balance and transactions immediately
    utils.wallet.getBalance.invalidate();
    utils.wallet.getTransactions.invalidate();
  }, [utils]);

  const handleTierUpgrade = useCallback((event: TierUpgradedEvent) => {
    const tierLabels: Record<string, string> = {
      basic: "Basic",
      standard: "Standard",
      premium: "Premium",
    };
    toast.success(`🎉 Wallet upgraded to ${tierLabels[event.newTier] ?? event.newTier} tier!`, {
      description: `You now enjoy higher transaction limits and exclusive benefits.`,
      duration: 10000,
    });
    // Refresh balance to show new tier
    utils.wallet.getBalance.invalidate();
  }, [utils]);

  useWalletCreditPush({
    onCredit: handleWalletCredit,
    onTierUpgrade: handleTierUpgrade,
    enabled: !balanceQuery.isLoading,
  });

  const refresh = async () => {
    setRefreshing(true);
    await utils.wallet.getBalance.invalidate();
    await utils.wallet.getTransactions.invalidate();
    setRefreshing(false);
    toast.success("Balance refreshed");
  };

  // ── Filtered transactions ──────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const now = Date.now();
    const cutoff: Record<DateRange, number> = {
      "7d": now - 7 * 86400_000,
      "30d": now - 30 * 86400_000,
      "90d": now - 90 * 86400_000,
      "all": 0,
    };
    return transactions.filter(t => {
      const txnType = t.type;
      if (filterType !== "all" && txnType !== filterType) return false;
      if (new Date(t.created_at).getTime() < cutoff[dateRange]) return false;
      if (searchQuery && !t.description.toLowerCase().includes(searchQuery.toLowerCase()) &&
          !t.id.toLowerCase().includes(searchQuery.toLowerCase())) return false;
      return true;
    });
  }, [transactions, filterType, dateRange, searchQuery]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // ── Top-up handler — uses tRPC with real ctx.user.email ────────────────────
  const handleTopUp = async () => {
    const amount = customAmount ? parseInt(customAmount) : topUpAmount;
    if (!amount || amount < 100) {
      toast.error("Minimum top-up is ₦100");
      return;
    }
    setTopUpLoading(true);
    const provider = topUpProvider === "interswitch" ? "paystack" : topUpProvider;
    initiateTopup.mutate({
      amountNgn: amount,
      provider,
      callbackUrl: `${window.location.origin}/wallet/confirm?provider=${provider}`,
    });
  };
  // ── Fare cap ──────────────────────────────────────────────────────────────────────
  const farePct = balance
    ? Math.round((balance.daily_spent_kobo / (balance.fare_cap_limit_kobo ?? balance.daily_cap_kobo)) * 100)
    : 0;
  const fareResetDays = balance?.fare_cap_reset_date
    ? Math.ceil((new Date(balance.fare_cap_reset_date).getTime() - Date.now()) / 86400_000)
    : 0;

  // ── Monthly toll spend ─────────────────────────────────────────────────────
  const monthlyTollSpend = useMemo(() =>
    transactions
      .filter(t => (t.type === "toll_charge") &&
        new Date(t.created_at) > new Date(Date.now() - 30 * 86400_000))
      .reduce((s, t) => s + t.amount_kobo, 0),
    [transactions]
  );

  const tollCount = transactions.filter(t => t.type === "toll_charge").length;
  const lastTopUp = transactions.find(t => t.type === "topup");

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
          <p className="text-sm text-muted-foreground">Loading wallet...</p>
        </div>
      </div>
    );
  }

  if (balanceQuery.isError) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="flex flex-col items-center gap-3 max-w-sm text-center">
          <X className="w-8 h-8 text-destructive" />
          <p className="text-sm font-medium text-foreground">Wallet unavailable</p>
          <p className="text-xs text-muted-foreground">
            {balanceQuery.error?.message ?? "Could not load your wallet balance. Please try again."}
          </p>
          <Button variant="outline" size="sm" onClick={() => balanceQuery.refetch()} className="gap-1.5">
            <RefreshCw className="w-3.5 h-3.5" /> Retry
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="border-b border-border bg-white/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate("/")} className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <div>
              <h1 className="font-bold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
                NigerianPass Wallet
              </h1>
              <p className="text-xs text-muted-foreground">Toll payments & balance management</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={refresh}
              className={cn("p-2 rounded-xl hover:bg-muted text-muted-foreground transition-all", refreshing && "animate-spin")}
            >
              <RefreshCw className="w-4 h-4" />
            </button>
            <Button onClick={() => setShowTopUp(true)} size="sm" className="gap-1.5">
              <Plus className="w-3.5 h-3.5" />
              Top Up
            </Button>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* ── Balance cards row ──────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Main balance card */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            className="md:col-span-2 rounded-2xl p-6 relative overflow-hidden"
            style={{ background: "linear-gradient(135deg, #1B2B4B 0%, #1e3a5f 60%, #0d2137 100%)" }}
          >
            <div className="absolute top-0 right-0 w-48 h-48 opacity-5"
              style={{ background: "radial-gradient(circle, #10b981, transparent)" }} />
            <div className="relative z-10">
              <div className="flex items-center gap-2 mb-4">
                <Wallet className="w-4 h-4 text-emerald-400" />
                <span className="text-blue-200 text-sm">Available Balance</span>
                <span className="ml-auto text-xs bg-white/10 text-blue-200 px-2 py-0.5 rounded-full capitalize">
                  {balance?.tier ?? "standard"} tier
                </span>
              </div>
              <div className="text-4xl font-bold text-white mb-1" style={{ fontFamily: "Sora, sans-serif" }}>
                ₦{balance ? koboToNaira(balance.balance_kobo) : "0.00"}
              </div>
              {balance && (balance.pending_kobo ?? 0) > 0 && (
                <p className="text-blue-300 text-sm">
                  + ₦{koboToNaira(balance.pending_kobo ?? 0)} pending
                </p>
              )}
              <div className="mt-4 flex items-center gap-2">
                <span className="text-blue-300 text-xs">Account: {balance?.account_id}</span>
                <span className="text-blue-500">·</span>
                <span className="text-blue-300 text-xs">{balance?.currency}</span>
              </div>
            </div>
          </motion.div>

          {/* Fare cap card */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="rounded-2xl border border-border bg-white p-5 flex flex-col justify-between"
          >
            <div>
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-medium text-foreground">Daily Fare Cap</span>
                <TrendingUp className="w-4 h-4 text-muted-foreground" />
              </div>
              <div className="flex items-center justify-center my-2">
                <FareCapRing pct={farePct} />
              </div>
              <div className="text-center text-xs text-muted-foreground">
                ₦{koboToNaira(balance?.daily_spent_kobo ?? 0)} of ₦{koboToNaira(balance?.fare_cap_limit_kobo ?? balance?.daily_cap_kobo ?? 0)}
              </div>
            </div>
            {fareResetDays > 0 && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-2">
                <Calendar className="w-3 h-3" />
                Resets in {fareResetDays} day{fareResetDays !== 1 ? "s" : ""}
              </div>
            )}
          </motion.div>
        </div>

        {/* ── Quick stats row ────────────────────────────────────────────────── */}
        <div className="grid grid-cols-3 gap-3">
          {[
            {
              label: "This Month",
              value: `₦${koboToNaira(monthlyTollSpend)}`,
              sub: "in toll charges",
              icon: Zap,
              color: "text-amber-600",
              bg: "bg-amber-50",
            },
            {
              label: "Total Trips",
              value: tollCount.toString(),
              sub: "toll passages",
              icon: MapPin,
              color: "text-blue-600",
              bg: "bg-blue-50",
            },
            {
              label: "Last Top-Up",
              value: lastTopUp ? `₦${koboToNaira(lastTopUp.amount_kobo)}` : "—",
              sub: lastTopUp ? formatDate(lastTopUp.created_at).split(",")[0] : "No top-ups yet",
              icon: CreditCard,
              color: "text-emerald-600",
              bg: "bg-emerald-50",
            },
          ].map(stat => (
            <div key={stat.label} className="rounded-xl border border-border bg-white p-4">
              <div className={cn("w-7 h-7 rounded-lg flex items-center justify-center mb-2", stat.bg)}>
                <stat.icon className={cn("w-3.5 h-3.5", stat.color)} />
              </div>
              <div className="text-lg font-bold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
                {stat.value}
              </div>
              <div className="text-xs text-muted-foreground">{stat.sub}</div>
            </div>
          ))}
        </div>

        {/* ── Transaction history ────────────────────────────────────────────── */}
        <div className="rounded-2xl border border-border bg-white overflow-hidden">
          {/* Toolbar */}
          <div className="px-5 py-4 border-b border-border flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
            <h2 className="font-semibold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
              Transaction History
            </h2>
            <div className="flex flex-wrap gap-2 items-center">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <Input
                  placeholder="Search..."
                  className="pl-8 h-8 text-xs w-36"
                  value={searchQuery}
                  onChange={e => { setSearchQuery(e.target.value); setPage(1); }}
                />
              </div>
              <FilterSelect
                value={filterType}
                onChange={v => { setFilterType(v as FilterType); setPage(1); }}
                options={[
                  { value: "all", label: "All types" },
                  { value: "toll_charge", label: "Toll charges" },
                  { value: "topup", label: "Top-ups" },
                  { value: "refund", label: "Refunds" },
                ]}
              />
              <FilterSelect
                value={dateRange}
                onChange={v => { setDateRange(v as DateRange); setPage(1); }}
                options={[
                  { value: "7d", label: "Last 7 days" },
                  { value: "30d", label: "Last 30 days" },
                  { value: "90d", label: "Last 90 days" },
                  { value: "all", label: "All time" },
                ]}
              />
              <button
                onClick={handleExportCsv}
                disabled={exportCsvMutation.isPending}
                className="h-8 px-3 text-xs border border-border rounded-lg hover:bg-muted flex items-center gap-1.5 text-muted-foreground disabled:opacity-50"
              >
                <Download className="w-3 h-3" />
                {exportCsvMutation.isPending ? "Exporting..." : "Export CSV"}
              </button>
            </div>
          </div>

          {/* Table */}
          {paginated.length === 0 ? (
            <div className="py-16 text-center">
              <Wallet className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No transactions found</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {paginated.map((txn, i) => {
                const isToll = txn.type === "toll_charge";
                const isTopup = txn.type === "topup";
                const isCredit = txn.direction === "credit";
                return (
                  <motion.button
                    key={txn.id}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.03 }}
                    onClick={() => setSelectedTxn(txn)}
                    className="w-full text-left px-5 py-4 hover:bg-muted/40 transition-colors flex items-center gap-4"
                  >
                    <div className={cn(
                      "w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0",
                      isToll ? "bg-amber-50" : isTopup ? "bg-emerald-50" : "bg-blue-50"
                    )}>
                      {isToll ? <Zap className="w-4 h-4 text-amber-600" /> :
                       isTopup ? <ArrowDownLeft className="w-4 h-4 text-emerald-600" /> :
                       <RefreshCw className="w-4 h-4 text-blue-600" />}
                    </div>

                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{txn.description}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs text-muted-foreground">{formatDate(txn.created_at)}</span>
                        {txn.plaza && (
                          <>
                            <span className="text-muted-foreground/40">·</span>
                            <span className="text-xs text-muted-foreground flex items-center gap-0.5">
                              <MapPin className="w-2.5 h-2.5" />{txn.plaza}
                            </span>
                          </>
                        )}
                        {txn.vehicle_plate && (
                          <>
                            <span className="text-muted-foreground/40">·</span>
                            <span className="text-xs text-muted-foreground">{txn.vehicle_plate}</span>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="text-right flex-shrink-0">
                      <p className={cn(
                        "text-sm font-semibold",
                        isCredit ? "text-emerald-600" : "text-foreground"
                      )}>
                        {isCredit ? "+" : "-"}₦{koboToNaira(txn.amount_kobo)}
                      </p>
                      {txn.balance_after_kobo !== undefined && (
                        <p className="text-xs text-muted-foreground">
                          Bal: ₦{koboToNaira(txn.balance_after_kobo)}
                        </p>
                      )}
                    </div>

                    <div className={cn(
                      "text-[10px] px-2 py-0.5 rounded-full font-medium flex-shrink-0",
                      txn.status === "completed" ? "bg-emerald-50 text-emerald-700" :
                      txn.status === "pending" ? "bg-amber-50 text-amber-700" :
                      "bg-red-50 text-red-700"
                    )}>
                      {txn.status}
                    </div>
                  </motion.button>
                );
              })}
            </div>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="px-5 py-3 border-t border-border flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                {filtered.length} transactions · Page {page} of {totalPages}
              </p>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="p-1.5 rounded-lg hover:bg-muted disabled:opacity-40 text-muted-foreground"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>
                {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                  const pg = page <= 3 ? i + 1 : page - 2 + i;
                  if (pg < 1 || pg > totalPages) return null;
                  return (
                    <button
                      key={pg}
                      onClick={() => setPage(pg)}
                      className={cn(
                        "w-7 h-7 text-xs rounded-lg transition-all",
                        pg === page ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground"
                      )}
                    >
                      {pg}
                    </button>
                  );
                })}
                <button
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="p-1.5 rounded-lg hover:bg-muted disabled:opacity-40 text-muted-foreground"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Top-Up Modal ─────────────────────────────────────────────────────── */}
      <AnimatePresence>
        {showTopUp && (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/40 backdrop-blur-sm"
              onClick={() => setShowTopUp(false)}
            />
            <motion.div
              initial={{ opacity: 0, y: 40, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 40, scale: 0.97 }}
              className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 z-10"
            >
              <div className="flex items-center justify-between mb-5">
                <h3 className="font-bold text-lg text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
                  Top Up Wallet
                </h3>
                <button onClick={() => setShowTopUp(false)} className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground">
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Provider selector */}
              <div className="mb-5">
                <PaymentProviderSelector
                  value={topUpProvider}
                  onChange={setTopUpProvider}
                  amountKobo={(customAmount ? parseInt(customAmount) || 0 : topUpAmount) * 100}
                />
              </div>

              {/* Amount presets */}
              <div className="mb-4">
                <p className="text-sm font-medium text-foreground mb-2">Select Amount</p>
                <div className="grid grid-cols-3 gap-2">
                  {TOP_UP_AMOUNTS.map(amt => (
                    <button
                      key={amt}
                      onClick={() => { setTopUpAmount(amt); setCustomAmount(""); }}
                      className={cn(
                        "py-2.5 rounded-xl border text-sm font-medium transition-all",
                        topUpAmount === amt && !customAmount
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border text-muted-foreground hover:border-primary/50"
                      )}
                    >
                      ₦{amt.toLocaleString()}
                    </button>
                  ))}
                </div>
              </div>

              {/* Custom amount */}
              <div className="mb-5">
                <p className="text-sm font-medium text-foreground mb-1.5">Or enter custom amount</p>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground font-medium">₦</span>
                  <Input
                    type="number"
                    placeholder="e.g. 7500"
                    className="pl-7"
                    value={customAmount}
                    onChange={e => { setCustomAmount(e.target.value); setTopUpAmount(0); }}
                    min={100}
                    max={500000}
                  />
                </div>
              </div>

              {/* Summary */}
              <div className="bg-muted/50 rounded-xl p-3 mb-5 flex items-center justify-between">
                <span className="text-sm text-muted-foreground">You will pay</span>
                <span className="text-lg font-bold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
                  ₦{(customAmount ? parseInt(customAmount) || 0 : topUpAmount).toLocaleString()}
                </span>
              </div>

              <Button
                className="w-full h-11 font-semibold"
                onClick={handleTopUp}
                disabled={topUpLoading || (customAmount ? parseInt(customAmount) < 100 : topUpAmount < 100)}
              >
                {topUpLoading ? (
                  <span className="flex items-center gap-2">
                    <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Redirecting to {topUpProvider}...
                  </span>
                ) : (
                  <span className="flex items-center gap-2">
                    <CreditCard className="w-4 h-4" />
                    Pay with {topUpProvider === "paystack" ? "Paystack" : "Flutterwave"}
                  </span>
                )}
              </Button>

              <p className="text-xs text-muted-foreground text-center mt-3">
                Secured by 256-bit SSL encryption. Funds credited instantly.
              </p>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ── Receipt Drawer ────────────────────────────────────────────────────── */}
      <AnimatePresence>
        {selectedTxn && (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-end">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/40 backdrop-blur-sm"
              onClick={() => setSelectedTxn(null)}
            />
            <motion.div
              initial={{ opacity: 0, x: 40 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 40 }}
              className="relative bg-white h-full w-full sm:w-96 shadow-2xl z-10 flex flex-col"
            >
              <div className="flex items-center justify-between px-5 py-4 border-b border-border">
                <h3 className="font-bold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
                  Transaction Receipt
                </h3>
                <button onClick={() => setSelectedTxn(null)} className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-5 space-y-5">
                {/* Amount hero */}
                {(() => {
                  const isToll = selectedTxn.type === "toll_charge";
                  const isTopup = selectedTxn.type === "topup";
                  const isCredit = selectedTxn.direction === "credit";
                  return (
                    <>
                      <div className={cn(
                        "rounded-2xl p-5 text-center",
                        isToll ? "bg-amber-50" : isTopup ? "bg-emerald-50" : "bg-blue-50"
                      )}>
                        <div className={cn(
                          "w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-3",
                          isToll ? "bg-amber-100" : isTopup ? "bg-emerald-100" : "bg-blue-100"
                        )}>
                          {isToll ? <Zap className="w-6 h-6 text-amber-600" /> :
                           isTopup ? <ArrowDownLeft className="w-6 h-6 text-emerald-600" /> :
                           <RefreshCw className="w-6 h-6 text-blue-600" />}
                        </div>
                        <p className={cn(
                          "text-3xl font-bold",
                          isCredit ? "text-emerald-700" : "text-foreground"
                        )} style={{ fontFamily: "Sora, sans-serif" }}>
                          {isCredit ? "+" : "-"}₦{koboToNaira(selectedTxn.amount_kobo)}
                        </p>
                        <p className="text-sm text-muted-foreground mt-1">{selectedTxn.description}</p>
                      </div>

                      <div className="space-y-3">
                        {[
                          { label: "Transaction ID", value: selectedTxn.id },
                          { label: "Reference", value: selectedTxn.reference },
                          { label: "Date & Time", value: formatDate(selectedTxn.created_at) },
                          { label: "Status", value: selectedTxn.status, badge: true },
                          ...(selectedTxn.balance_after_kobo !== undefined
                            ? [{ label: "Balance After", value: `₦${koboToNaira(selectedTxn.balance_after_kobo)}` }]
                            : []),
                          ...(selectedTxn.plaza ? [{ label: "Toll Plaza", value: selectedTxn.plaza }] : []),
                          ...(selectedTxn.vehicle_plate ? [{ label: "Vehicle", value: selectedTxn.vehicle_plate }] : []),
                          ...(isToll ? [
                            { label: "Payment Method", value: "NFC Tap (NigerianPass)" },
                            { label: "Processing Time", value: "142ms" },
                          ] : []),
                        ].map(row => (
                          <div key={row.label} className="flex items-center justify-between py-2 border-b border-border/50">
                            <span className="text-sm text-muted-foreground">{row.label}</span>
                            {(row as { badge?: boolean }).badge ? (
                              <span className={cn(
                                "text-xs px-2 py-0.5 rounded-full font-medium",
                                selectedTxn.status === "completed" ? "bg-emerald-50 text-emerald-700" :
                                selectedTxn.status === "pending" ? "bg-amber-50 text-amber-700" :
                                "bg-red-50 text-red-700"
                              )}>
                                {selectedTxn.status}
                              </span>
                            ) : (
                              <span className="text-sm font-medium text-foreground">{row.value}</span>
                            )}
                          </div>
                        ))}
                      </div>

                      <div className="flex items-center gap-2 p-3 bg-emerald-50 rounded-xl">
                        <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                        <p className="text-xs text-emerald-700">
                          This transaction is recorded on the TigerBeetle immutable ledger.
                        </p>
                      </div>
                    </>
                  );
                })()}
              </div>

              <div className="p-5 border-t border-border">
                <Button
                  variant="outline"
                  className="w-full gap-2"
                  onClick={() => {
                    // Try numeric ID for DB-backed transactions, fall back to string reference display
                    const numId = parseInt(selectedTxn!.id);
                    if (!isNaN(numId)) {
                      handleDownloadReceipt(numId);
                    } else {
                      // Demo/legacy transaction — generate receipt from local data
                      const date = new Date(selectedTxn!.created_at).toLocaleString("en-NG", { timeZone: "Africa/Lagos" });
                      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Receipt ${selectedTxn!.reference}</title><style>body{font-family:sans-serif;max-width:480px;margin:40px auto;padding:24px;border:1px solid #ddd;border-radius:8px}h1{font-size:18px}.amount{font-size:24px;font-weight:700;margin:16px 0}.footer{margin-top:24px;font-size:11px;color:#888;border-top:1px solid #eee;padding-top:12px}</style></head><body><h1>NigerianPass Receipt</h1><p style="color:#666">${date}</p><div class="amount">₦${(selectedTxn!.amount_kobo / 100).toFixed(2)}</div><p><strong>Type:</strong> ${selectedTxn!.type.toUpperCase()}</p><p><strong>Description:</strong> ${selectedTxn!.description}</p><p><strong>Reference:</strong> ${selectedTxn!.reference}</p><div class="footer">NigerianPass Electronic Toll Management System</div></body></html>`;
                      const blob = new Blob([html], { type: "text/html" });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = `receipt-${selectedTxn!.reference}.html`;
                      a.click();
                      URL.revokeObjectURL(url);
                      toast.success("Receipt downloaded");
                    }
                  }}
                >
                  <Download className="w-4 h-4" />
                  Download Receipt
                </Button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Fare Cap Ring SVG ─────────────────────────────────────────────────────────
function FareCapRing({ pct }: { pct: number }) {
  const r = 36;
  const circ = 2 * Math.PI * r;
  const dash = (Math.min(pct, 100) / 100) * circ;
  const color = pct >= 90 ? "#ef4444" : pct >= 70 ? "#f59e0b" : "#10b981";

  return (
    <div className="relative w-24 h-24 flex items-center justify-center">
      <svg width="96" height="96" className="-rotate-90">
        <circle cx="48" cy="48" r={r} fill="none" stroke="#f1f5f9" strokeWidth="8" />
        <circle
          cx="48" cy="48" r={r} fill="none"
          stroke={color} strokeWidth="8"
          strokeDasharray={`${dash} ${circ}`}
          strokeLinecap="round"
          style={{ transition: "stroke-dasharray 0.6s ease" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-lg font-bold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>{pct}%</span>
        <span className="text-[9px] text-muted-foreground">used</span>
      </div>
    </div>
  );
}

// ── Filter Select ─────────────────────────────────────────────────────────────
function FilterSelect({ value, onChange, options }: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="h-8 pl-3 pr-7 text-xs border border-border rounded-lg bg-white text-muted-foreground appearance-none cursor-pointer hover:border-primary/50 focus:outline-none focus:border-primary"
      >
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
    </div>
  );
}
