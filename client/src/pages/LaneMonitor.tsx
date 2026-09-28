/**
 * Lane Monitor — /portal/lanes
 * ====================================================
 * Live view of toll lane charge events. Per-plaza daily summary cards
 * (revenue, outcome counts, anti-passback blocks, top insufficient-fund tags)
 * and a 5-second polled event feed with fraud-risk highlighting and per-tag
 * crossing history on drill-down.
 *
 * Data source: trpc.lanes.* (recentEvents / laneSummary are per-plaza and
 * require a plazaId) + trpc.devices.plazaSummary for the plaza list.
 */
import { useEffect, useMemo, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import {
  Radio, Pause, Play, Loader2, AlertTriangle, MapPin, ShieldAlert,
  ArrowDownToLine, ArrowUpFromLine, ChevronLeft, ChevronRight,
  RefreshCw, History,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import PortalLayout from "@/components/PortalLayout";
import { trpc } from "@/lib/trpc";

// ── Constants / helpers (local to this page) ──────────────────────────────────
const PAGE_SIZE = 30;

const naira = new Intl.NumberFormat("en-NG", {
  style: "currency", currency: "NGN", maximumFractionDigits: 2,
});
const fmtNaira = (kobo: number | null | undefined) => naira.format((kobo ?? 0) / 100);

const CHARGE_STYLES: Record<string, string> = {
  charged: "bg-emerald-50 text-emerald-700 border-emerald-200",
  insufficient: "bg-amber-50 text-amber-700 border-amber-200",
  failed: "bg-red-50 text-red-700 border-red-200",
  queued: "bg-slate-100 text-slate-600 border-slate-200",
  free: "bg-sky-50 text-sky-700 border-sky-200",
  exempt: "bg-violet-50 text-violet-700 border-violet-200",
};

function fmtTime(d: string | Date | null | undefined) {
  if (!d) return "—";
  return new Date(d).toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtDateTime(d: string | Date | null | undefined) {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-NG", {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function fraudChip(score: number | null | undefined) {
  if (score === null || score === undefined) return null;
  const level = score >= 0.66 ? "high" : score >= 0.33 ? "med" : "low";
  const cls = level === "high"
    ? "bg-red-50 text-red-700 border-red-200"
    : level === "med"
    ? "bg-amber-50 text-amber-700 border-amber-200"
    : "bg-emerald-50 text-emerald-700 border-emerald-200";
  return { level, cls, label: `${level} ${(score * 100).toFixed(0)}%` };
}

function DirectionIcon({ direction }: { direction: string | null | undefined }) {
  return direction === "entry"
    ? <ArrowDownToLine className="w-3.5 h-3.5 text-sky-600" />
    : <ArrowUpFromLine className="w-3.5 h-3.5 text-violet-600" />;
}

// ── Per-plaza summary card (one laneSummary query per plaza) ──────────────────
function PlazaSummaryCard({ plazaId, selected, onSelect }: {
  plazaId: string; selected: boolean; onSelect: () => void;
}) {
  const summaryQuery = trpc.lanes.laneSummary.useQuery({ plazaId });
  const s = summaryQuery.data;

  return (
    <button onClick={onSelect}
      className={cn("text-left bg-white rounded-2xl border p-4 shadow-sm transition-all w-full",
        selected ? "border-primary ring-2 ring-primary/20" : "border-border hover:border-primary/40")}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <MapPin className="w-4 h-4 text-primary" />
          <span className="font-semibold text-sm">{plazaId}</span>
        </div>
        {s && <span className="text-xs text-muted-foreground">{s.totalEvents.toLocaleString()} events today</span>}
      </div>

      {summaryQuery.isLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading summary…
        </div>
      ) : summaryQuery.error ? (
        <p className="text-xs text-red-600 py-2">{summaryQuery.error.message}</p>
      ) : s ? (
        <>
          <div className="text-lg font-bold text-emerald-700 mb-3" style={{ fontFamily: "Sora, sans-serif" }}>
            {fmtNaira(s.revenueKobo)}
          </div>
          <div className="flex gap-2">
            <div className="flex-1 text-center p-2 bg-emerald-50 rounded-lg">
              <div className="text-base font-bold text-emerald-700">{s.countsByStatus.charged ?? 0}</div>
              <div className="text-[10px] text-emerald-600">Charged</div>
            </div>
            <div className="flex-1 text-center p-2 bg-amber-50 rounded-lg">
              <div className="text-base font-bold text-amber-700">{s.countsByStatus.insufficient ?? 0}</div>
              <div className="text-[10px] text-amber-600">Insufficient</div>
            </div>
            <div className="flex-1 text-center p-2 bg-red-50 rounded-lg">
              <div className="text-base font-bold text-red-700">{s.countsByStatus.failed ?? 0}</div>
              <div className="text-[10px] text-red-600">Failed</div>
            </div>
            <div className={cn("flex-1 text-center p-2 rounded-lg",
              s.antiPassbackBlocked > 0 ? "bg-orange-50 border border-orange-300" : "bg-muted")}>
              <div className={cn("text-base font-bold flex items-center justify-center gap-1",
                s.antiPassbackBlocked > 0 ? "text-orange-700" : "text-foreground")}>
                {s.antiPassbackBlocked > 0 && <ShieldAlert className="w-3.5 h-3.5" />}
                {s.antiPassbackBlocked}
              </div>
              <div className={cn("text-[10px]", s.antiPassbackBlocked > 0 ? "text-orange-600" : "text-muted-foreground")}>
                Passback
              </div>
            </div>
          </div>
          {s.topInsufficientTags.length > 0 && (
            <div className="mt-3 pt-2 border-t border-border">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Top insufficient-fund tags</div>
              <div className="flex flex-wrap gap-1">
                {s.topInsufficientTags.slice(0, 3).map(t => (
                  <span key={t.tagEpc} className="font-mono text-[10px] px-1.5 py-0.5 bg-amber-50 border border-amber-200 text-amber-700 rounded">
                    {t.tagEpc.slice(-6)} ×{t.count}
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      ) : null}
    </button>
  );
}

// ── Tag history panel (inside event detail dialog) ────────────────────────────
function TagHistory({ tagEpc }: { tagEpc: string }) {
  const historyQuery = trpc.lanes.tagHistory.useQuery({ tagEpc, limit: 10 });

  if (historyQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading tag history…
      </div>
    );
  }
  if (historyQuery.error) {
    return <p className="text-xs text-red-600 py-2">History unavailable: {historyQuery.error.message}</p>;
  }
  const items = historyQuery.data?.events ?? [];
  if (items.length === 0) {
    return <p className="text-xs text-muted-foreground py-2">No prior crossings recorded for this tag.</p>;
  }
  return (
    <div className="space-y-1.5 max-h-56 overflow-y-auto">
      {items.map(e => (
        <div key={e.id} className="flex items-center gap-3 text-xs border border-border rounded-lg px-3 py-2">
          <span className="text-muted-foreground whitespace-nowrap">{fmtDateTime(e.occurredAt)}</span>
          <span className="flex items-center gap-1 shrink-0">
            <MapPin className="w-3 h-3 text-muted-foreground" />{e.plazaId}/{e.laneId}
          </span>
          <span className="ml-auto font-semibold">{fmtNaira(e.amountKobo)}</span>
          <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full border font-medium capitalize shrink-0",
            CHARGE_STYLES[e.chargeStatus] ?? "bg-muted text-muted-foreground border-border")}>
            {e.chargeStatus}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function LaneMonitor() {
  const [live, setLive] = useState(true);
  const [plazaFilter, setPlazaFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [page, setPage] = useState(1); // lanes.recentEvents pages are 1-based
  const [selectedEventUid, setSelectedEventUid] = useState<string | null>(null);

  // Plaza list comes from the device registry (lanes router is per-plaza).
  const plazasQuery = trpc.devices.plazaSummary.useQuery();
  const plazas = useMemo(
    () => (plazasQuery.data ?? []).map(p => p.plaza),
    [plazasQuery.data],
  );

  // Default to the first plaza once the list loads.
  useEffect(() => {
    if (!plazaFilter && plazas.length > 0) setPlazaFilter(plazas[0]);
  }, [plazas, plazaFilter]);

  const eventsQuery = trpc.lanes.recentEvents.useQuery(
    {
      plazaId: plazaFilter,
      page,
      limit: PAGE_SIZE,
      chargeStatus: statusFilter === "all" ? undefined : (statusFilter as "charged" | "insufficient" | "free" | "exempt" | "queued" | "failed"),
    },
    {
      enabled: !!plazaFilter,
      refetchInterval: live ? 5_000 : false,
      placeholderData: keepPreviousData,
    },
  );

  const events = eventsQuery.data?.events ?? [];
  const hasNextPage = events.length >= PAGE_SIZE;
  const selectedEvent = events.find(e => e.eventUid === selectedEventUid) ?? null;

  return (
    <PortalLayout title="Lane Monitor" subtitle="Live toll lane charge events across plazas">
      <div className="p-4 md:p-6 lg:p-8 space-y-6">

        {/* Per-plaza summary cards */}
        {plazasQuery.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading plazas…
          </div>
        ) : plazasQuery.error ? (
          <Alert variant="destructive">
            <AlertTriangle className="w-4 h-4" />
            <AlertTitle>Failed to load plazas</AlertTitle>
            <AlertDescription>{plazasQuery.error.message}</AlertDescription>
          </Alert>
        ) : plazas.length === 0 ? (
          <Alert>
            <AlertTriangle className="w-4 h-4" />
            <AlertTitle>No plazas registered</AlertTitle>
            <AlertDescription>Register toll devices first — lane events are grouped by plaza.</AlertDescription>
          </Alert>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {plazas.map(p => (
              <PlazaSummaryCard key={p} plazaId={p}
                selected={plazaFilter === p}
                onSelect={() => { setPlazaFilter(p); setPage(1); }} />
            ))}
          </div>
        )}

        {/* Live events feed */}
        <div className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <span className={cn("w-2.5 h-2.5 rounded-full", live ? "bg-emerald-500 animate-pulse" : "bg-slate-400")} />
              <span className={cn("text-xs font-bold tracking-widest", live ? "text-emerald-600" : "text-slate-500")}>
                {live ? "LIVE" : "PAUSED"}
              </span>
              {live && eventsQuery.isFetching && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
            </div>
            <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={() => setLive(v => !v)}>
              {live ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              {live ? "Pause" : "Resume"}
            </Button>
            <div className="ml-auto flex items-center gap-2 flex-wrap">
              <Select value={plazaFilter} onValueChange={v => { setPlazaFilter(v); setPage(1); }}>
                <SelectTrigger className="h-8 w-40 text-xs"><SelectValue placeholder="Select plaza" /></SelectTrigger>
                <SelectContent>
                  {plazas.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={statusFilter} onValueChange={v => { setStatusFilter(v); setPage(1); }}>
                <SelectTrigger className="h-8 w-36 text-xs"><SelectValue placeholder="All statuses" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  {["charged", "insufficient", "free", "exempt", "queued", "failed"].map(s => (
                    <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button size="sm" variant="outline" className="h-8 w-8 p-0" onClick={() => eventsQuery.refetch()}
                disabled={eventsQuery.isFetching} title="Refresh now">
                <RefreshCw className={cn("w-3.5 h-3.5", eventsQuery.isFetching && "animate-spin")} />
              </Button>
            </div>
          </div>

          {eventsQuery.error && (
            <div className="p-4">
              <Alert variant="destructive">
                <AlertTriangle className="w-4 h-4" />
                <AlertTitle>Failed to load lane events</AlertTitle>
                <AlertDescription>{eventsQuery.error.message}</AlertDescription>
              </Alert>
            </div>
          )}

          {!plazaFilter ? (
            <div className="p-12 text-center text-muted-foreground">
              <Radio className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">Select a plaza to view its live event feed</p>
            </div>
          ) : eventsQuery.isLoading ? (
            <div className="p-12 flex items-center justify-center gap-2 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin" /><span className="text-sm">Connecting to lane feed…</span>
            </div>
          ) : events.length === 0 && !eventsQuery.error ? (
            <div className="p-12 text-center text-muted-foreground">
              <Radio className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No lane events recorded for {plazaFilter} yet</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {events.map(e => {
                const chip = fraudChip(e.fraudScore);
                return (
                  <button key={e.eventUid}
                    onClick={() => setSelectedEventUid(e.eventUid)}
                    className="w-full text-left px-4 py-3 hover:bg-muted/30 transition-colors flex items-center gap-3 flex-wrap">
                    {/* Time */}
                    <span className="text-xs text-muted-foreground w-20 shrink-0 tabular-nums">{fmtTime(e.occurredAt)}</span>

                    {/* Lane */}
                    <span className="flex items-center gap-1 text-xs shrink-0 w-24 truncate">
                      <MapPin className="w-3 h-3 text-muted-foreground shrink-0" />
                      <span className="truncate">{e.laneId}</span>
                    </span>

                    {/* EPC */}
                    <span className="font-mono text-xs font-semibold truncate flex-1 min-w-32">{e.tagEpc}</span>

                    {/* Tag plate (joined) */}
                    {e.tag?.vehiclePlate && (
                      <span className="text-xs text-muted-foreground shrink-0 hidden md:inline">{e.tag.vehiclePlate}</span>
                    )}

                    {/* Direction */}
                    <span className="flex items-center gap-1 text-xs capitalize text-muted-foreground shrink-0">
                      <DirectionIcon direction={e.direction} />
                      <span className="hidden sm:inline">{e.direction}</span>
                    </span>

                    {/* Amount */}
                    <span className="text-xs font-semibold w-20 text-right shrink-0">{fmtNaira(e.amountKobo)}</span>

                    {/* Charge status */}
                    <span className={cn("text-[10px] px-2 py-0.5 rounded-full border font-medium capitalize shrink-0",
                      CHARGE_STYLES[e.chargeStatus] ?? "bg-muted text-muted-foreground border-border")}>
                      {e.chargeStatus}
                    </span>

                    {/* Fraud risk chip */}
                    {chip && (
                      <span className={cn("text-[10px] px-2 py-0.5 rounded-full border font-medium shrink-0", chip.cls)}>
                        risk {chip.label}
                      </span>
                    )}

                    {/* Anti-passback flag */}
                    {e.antiPassbackBlocked && (
                      <span title="Anti-passback blocked" className="shrink-0">
                        <ShieldAlert className="w-4 h-4 text-orange-500" />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {plazaFilter && (page > 1 || hasNextPage) && (
            <div className="p-3 border-t border-border flex items-center justify-between text-xs text-muted-foreground">
              <span>Page {page}</span>
              <div className="flex gap-1.5">
                <Button size="sm" variant="outline" className="h-7 w-7 p-0" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
                  <ChevronLeft className="w-3.5 h-3.5" />
                </Button>
                <Button size="sm" variant="outline" className="h-7 w-7 p-0" disabled={!hasNextPage} onClick={() => setPage(p => p + 1)}>
                  <ChevronRight className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Event detail dialog ── */}
      <Dialog open={!!selectedEventUid} onOpenChange={(o) => !o && setSelectedEventUid(null)}>
        <DialogContent className="sm:max-w-lg">
          {selectedEvent ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Radio className="w-5 h-5 text-primary" /> Lane Event
                </DialogTitle>
                <DialogDescription className="font-mono text-xs break-all">
                  {selectedEvent.eventUid}
                </DialogDescription>
              </DialogHeader>

              <div className="grid grid-cols-2 gap-2.5 py-2">
                {[
                  { label: "Occurred", value: fmtDateTime(selectedEvent.occurredAt) },
                  { label: "Received", value: fmtDateTime(selectedEvent.receivedAt) },
                  { label: "Plaza", value: selectedEvent.plazaId },
                  { label: "Lane", value: selectedEvent.laneId },
                  { label: "Direction", value: selectedEvent.direction },
                  { label: "Amount", value: fmtNaira(selectedEvent.amountKobo) },
                  { label: "Charge Status", value: selectedEvent.chargeStatus },
                  { label: "Wallet", value: selectedEvent.walletId ? `#${selectedEvent.walletId}` : "—" },
                  { label: "Wallet Balance", value: selectedEvent.wallet ? fmtNaira(selectedEvent.wallet.balanceKobo) : "—" },
                  { label: "Reader", value: selectedEvent.readerId ?? "—" },
                  { label: "Fraud Score", value: selectedEvent.fraudScore != null ? selectedEvent.fraudScore.toFixed(3) : "—" },
                  { label: "Anti-Passback", value: selectedEvent.antiPassbackBlocked ? "Blocked" : "Clear" },
                ].map(f => (
                  <div key={f.label} className="bg-muted/50 rounded-lg px-3 py-2">
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wide">{f.label}</div>
                    <div className="text-xs font-medium mt-0.5 break-all">{f.value}</div>
                  </div>
                ))}
              </div>

              <div className="px-3 py-2 bg-muted rounded-lg space-y-1">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Tag EPC</div>
                <span className="font-mono text-xs font-semibold break-all">{selectedEvent.tagEpc}</span>
                {selectedEvent.tag && (
                  <div className="text-[11px] text-muted-foreground capitalize">
                    {selectedEvent.tag.tagType.replace(/_/g, " ")} · {selectedEvent.tag.status}
                    {selectedEvent.tag.vehiclePlate ? ` · ${selectedEvent.tag.vehiclePlate}` : ""}
                  </div>
                )}
              </div>

              {selectedEvent.rawPayload && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground font-medium">Raw payload</summary>
                  <pre className="mt-1.5 p-2.5 bg-muted rounded-lg overflow-x-auto font-mono text-[10px] leading-relaxed max-h-40 overflow-y-auto">
                    {JSON.stringify(selectedEvent.rawPayload, null, 2)}
                  </pre>
                </details>
              )}

              <div>
                <div className="flex items-center gap-1.5 mb-2 mt-1">
                  <History className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="text-xs font-semibold">Recent crossings for this tag</span>
                </div>
                <TagHistory tagEpc={selectedEvent.tagEpc} />
              </div>
            </>
          ) : (
            <div className="p-6 text-sm text-muted-foreground">Event no longer in the current feed window.</div>
          )}
        </DialogContent>
      </Dialog>
    </PortalLayout>
  );
}
