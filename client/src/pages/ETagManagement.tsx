/**
 * eTag / RFID Management — /portal/etag
 * ====================================================
 * Issue, activate, suspend, report-lost, replace and decommission toll tags
 * (RFID windshield stickers, eTags, NFC cards), link them to wallets, and
 * look tags up by EPC or vehicle plate.
 *
 * Data source: trpc.etag.*
 */
import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  Tag, Plus, Search, Loader2, RefreshCw, CheckCircle2, PauseCircle,
  AlertTriangle, Repeat, Link2, Ban, Wallet, CreditCard, Nfc, ChevronLeft,
  ChevronRight, CarFront,
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
import { useAuth } from "@/_core/hooks/useAuth";

// ── Types (mirror server contract) ────────────────────────────────────────────
type TagType = "rfid_windshield" | "etag" | "nfc_card";

type ConfirmAction = "activate" | "suspend" | "reportLost" | "decommission";

const TAG_TYPES: { value: TagType; label: string; icon: React.ElementType }[] = [
  { value: "rfid_windshield", label: "RFID Windshield", icon: CarFront },
  { value: "etag", label: "eTag", icon: CreditCard },
  { value: "nfc_card", label: "NFC Card", icon: Nfc },
];

const STATUS_STYLES: Record<string, string> = {
  issued: "bg-sky-50 text-sky-700 border-sky-200",
  active: "bg-emerald-50 text-emerald-700 border-emerald-200",
  suspended: "bg-amber-50 text-amber-700 border-amber-200",
  lost: "bg-red-50 text-red-700 border-red-200",
  replaced: "bg-violet-50 text-violet-700 border-violet-200",
  decommissioned: "bg-slate-100 text-slate-600 border-slate-200",
};

const EPC_RE = /^[0-9a-fA-F]{24}$/;
const PAGE_SIZE = 25;

function fmtDate(d: string | Date | null | undefined) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-NG", {
    day: "numeric", month: "short", year: "numeric",
  });
}

function normalizeEpc(raw: string) {
  return raw.trim().toUpperCase();
}

function tagTypeMeta(t: string) {
  return TAG_TYPES.find(x => x.value === t) ?? { value: t, label: t, icon: Tag };
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function ETagManagement() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const utils = trpc.useUtils();

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<
    "all" | "issued" | "active" | "suspended" | "lost" | "replaced" | "decommissioned"
  >("all");
  const [page, setPage] = useState(1); // etag.list pages are 1-based

  const [issueOpen, setIssueOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ action: ConfirmAction; tagEpc: string } | null>(null);
  const [replaceTag, setReplaceTag] = useState<string | null>(null);
  const [replaceEpc, setReplaceEpc] = useState("");
  const [linkTag, setLinkTag] = useState<string | null>(null);
  const [linkWalletId, setLinkWalletId] = useState("");

  // Issue form state
  const [issueEpc, setIssueEpc] = useState("");
  const [issueType, setIssueType] = useState<TagType>("rfid_windshield");
  const [issuePlate, setIssuePlate] = useState("");
  const [issueWalletId, setIssueWalletId] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => { setPage(1); }, [debouncedSearch, statusFilter]);

  // ── Queries ───────────────────────────────────────────────────────────────
  const listQuery = trpc.etag.list.useQuery({
    page,
    limit: PAGE_SIZE,
    search: debouncedSearch || undefined,
    status: statusFilter === "all" ? undefined : statusFilter,
  });
  const activeCountQuery = trpc.etag.list.useQuery({ limit: 1, status: "active" });
  const suspendedCountQuery = trpc.etag.list.useQuery({ limit: 1, status: "suspended" });
  const myTagsQuery = trpc.etag.myTags.useQuery(undefined, { enabled: !isAdmin });

  const invalidateAll = () => {
    utils.etag.list.invalidate();
    utils.etag.myTags.invalidate();
  };

  // ── Mutations ─────────────────────────────────────────────────────────────
  const issueMutation = trpc.etag.issue.useMutation({
    onSuccess: (data) => {
      toast.success(`Tag ${data.tagEpc} issued (${data.status})`);
      setIssueOpen(false);
      setIssueEpc(""); setIssuePlate(""); setIssueWalletId("");
      invalidateAll();
    },
    onError: (err) => toast.error(`Issue failed: ${err.message}`),
  });

  const statusMutationOpts = (label: string) => ({
    onSuccess: (data: { tagEpc: string; status: string }) => {
      toast.success(`${data.tagEpc} — ${data.status}`);
      setConfirm(null);
      invalidateAll();
    },
    onError: (err: { message: string }) => toast.error(`${label} failed: ${err.message}`),
  });

  const activateMutation = trpc.etag.activate.useMutation(statusMutationOpts("Activate"));
  const suspendMutation = trpc.etag.suspend.useMutation(statusMutationOpts("Suspend"));
  const reportLostMutation = trpc.etag.reportLost.useMutation(statusMutationOpts("Report lost"));
  const decommissionMutation = trpc.etag.decommission.useMutation(statusMutationOpts("Decommission"));

  const replaceMutation = trpc.etag.replace.useMutation({
    onSuccess: (data) => {
      toast.success(`Tag replaced: ${data.oldTag.tagEpc} → ${data.newTag.tagEpc}`);
      setReplaceTag(null); setReplaceEpc("");
      invalidateAll();
    },
    onError: (err) => toast.error(`Replace failed: ${err.message}`),
  });

  const linkWalletMutation = trpc.etag.linkWallet.useMutation({
    onSuccess: () => {
      toast.success("Wallet linked to tag");
      setLinkTag(null); setLinkWalletId("");
      invalidateAll();
    },
    onError: (err) => toast.error(`Link failed: ${err.message}`),
  });

  const confirmMutation = {
    activate: activateMutation,
    suspend: suspendMutation,
    reportLost: reportLostMutation,
    decommission: decommissionMutation,
  } as const;

  const confirmMeta: Record<ConfirmAction, { title: string; body: string; cta: string; cls: string; icon: React.ElementType }> = {
    activate: { title: "Activate tag", body: "The tag will be enabled for toll charging immediately.", cta: "Activate", cls: "bg-emerald-600 hover:bg-emerald-700", icon: CheckCircle2 },
    suspend: { title: "Suspend tag", body: "The tag will be blocked from toll charging until reactivated.", cta: "Suspend", cls: "bg-amber-500 hover:bg-amber-600", icon: PauseCircle },
    reportLost: { title: "Report tag lost", body: "The tag will be permanently blocked and flagged as lost. A replacement can be issued afterwards.", cta: "Report Lost", cls: "bg-red-600 hover:bg-red-700", icon: AlertTriangle },
    decommission: { title: "Decommission tag", body: "The tag will be retired permanently and cannot be used again. This cannot be undone.", cta: "Decommission", cls: "bg-slate-700 hover:bg-slate-800", icon: Ban },
  };

  const issueEpcValid = EPC_RE.test(issueEpc.trim());
  const replaceEpcValid = EPC_RE.test(replaceEpc.trim());

  const items = listQuery.data?.tags ?? [];
  const total = listQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const stats = useMemo(() => ({
    total: listQuery.data?.total ?? 0,
    active: activeCountQuery.data?.total ?? 0,
    suspended: suspendedCountQuery.data?.total ?? 0,
  }), [listQuery.data, activeCountQuery.data, suspendedCountQuery.data]);

  const pendingAction =
    activateMutation.isPending || suspendMutation.isPending ||
    reportLostMutation.isPending || decommissionMutation.isPending;

  return (
    <PortalLayout title="eTag / RFID Management" subtitle="Issue, activate and manage toll tags">
      <div className="p-4 md:p-6 lg:p-8 space-y-6">

        {/* Stats Row */}
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: "Total Tags", value: stats.total, color: "text-foreground", bg: "bg-white border border-border" },
            { label: "Active", value: stats.active, color: "text-emerald-700", bg: "bg-emerald-50 border border-emerald-200" },
            { label: "Suspended", value: stats.suspended, color: "text-amber-700", bg: "bg-amber-50 border border-amber-200" },
          ].map(s => (
            <motion.div key={s.label} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
              className={cn("rounded-xl p-3 md:p-4 text-center shadow-sm", s.bg)}>
              <div className={cn("text-xl md:text-2xl font-bold", s.color)}>{s.value.toLocaleString()}</div>
              <div className="text-xs text-muted-foreground mt-0.5">{s.label}</div>
            </motion.div>
          ))}
        </div>

        {/* My Tags (regular users) */}
        {!isAdmin && (
          <div className="bg-white rounded-2xl border border-border shadow-sm p-4 md:p-5">
            <div className="flex items-center gap-2 mb-3">
              <Tag className="w-4 h-4 text-primary" />
              <h3 className="font-semibold text-sm" style={{ fontFamily: "Sora, sans-serif" }}>My Tags</h3>
            </div>
            {myTagsQuery.isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading your tags…
              </div>
            ) : (myTagsQuery.data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">
                No tags linked to your account yet. Once a tag is issued to your vehicle or wallet it will appear here.
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {(myTagsQuery.data ?? []).map((t) => (
                  <div key={t.id} className="border border-border rounded-xl p-3 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs font-semibold truncate">{t.tagEpc}</span>
                      <span className={cn("text-[10px] px-2 py-0.5 rounded-full border font-medium capitalize shrink-0",
                        STATUS_STYLES[t.status] ?? "bg-muted text-muted-foreground border-border")}>
                        {t.status}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
                      <span className="capitalize">{tagTypeMeta(t.tagType).label}</span>
                      {t.vehiclePlate && <><span>·</span><span className="font-medium">{t.vehiclePlate}</span></>}
                    </div>
                    {t.status === "active" && (
                      <div className="flex gap-1.5 pt-1">
                        <Button size="sm" variant="outline" className="h-7 text-xs gap-1 text-amber-600 border-amber-200 hover:bg-amber-50"
                          onClick={() => setConfirm({ action: "suspend", tagEpc: t.tagEpc })}>
                          <PauseCircle className="w-3 h-3" /> Suspend
                        </Button>
                        <Button size="sm" variant="outline" className="h-7 text-xs gap-1 text-red-600 border-red-200 hover:bg-red-50"
                          onClick={() => setConfirm({ action: "reportLost", tagEpc: t.tagEpc })}>
                          <AlertTriangle className="w-3 h-3" /> Report Lost
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Tag registry */}
        <div className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex items-center gap-3 flex-wrap">
            <div className="relative flex-1 min-w-48">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search by EPC or plate…" className="pl-9 h-9 font-mono" />
            </div>
            <div className="flex gap-1.5 flex-wrap">
              {(["all", "issued", "active", "suspended", "lost", "decommissioned"] as const).map(s => (
                <button key={s} onClick={() => setStatusFilter(s)}
                  className={cn("px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-all",
                    statusFilter === s ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/80")}>
                  {s}
                </button>
              ))}
            </div>
            <Button size="sm" variant="outline" className="h-9 w-9 p-0" onClick={() => listQuery.refetch()}
              disabled={listQuery.isFetching} title="Refresh">
              <RefreshCw className={cn("w-4 h-4", listQuery.isFetching && "animate-spin")} />
            </Button>
            <Button size="sm" className="h-9 gap-1.5 bg-emerald-600 hover:bg-emerald-700"
              onClick={() => setIssueOpen(true)}>
              <Plus className="w-4 h-4" /> Issue New Tag
            </Button>
          </div>

          {listQuery.error && (
            <div className="p-4">
              <Alert variant="destructive">
                <AlertTriangle className="w-4 h-4" />
                <AlertTitle>Failed to load tags</AlertTitle>
                <AlertDescription>{listQuery.error.message}</AlertDescription>
              </Alert>
            </div>
          )}

          {listQuery.isLoading ? (
            <div className="p-12 flex items-center justify-center gap-2 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin" />
              <span className="text-sm">Loading tags…</span>
            </div>
          ) : items.length === 0 && !listQuery.error ? (
            <div className="p-12 text-center text-muted-foreground">
              <Tag className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">{debouncedSearch ? "No tags match your search" : "No tags issued yet"}</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[760px]">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b border-border bg-muted/40">
                    <th className="px-4 py-2.5 font-medium">Tag EPC</th>
                    <th className="px-4 py-2.5 font-medium">Type</th>
                    <th className="px-4 py-2.5 font-medium">Plate</th>
                    <th className="px-4 py-2.5 font-medium">Wallet</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                    <th className="px-4 py-2.5 font-medium">Issued</th>
                    <th className="px-4 py-2.5 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {items.map(t => {
                    const meta = tagTypeMeta(t.tagType);
                    const TypeIcon = meta.icon;
                    return (
                      <tr key={t.id} className="hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-3">
                          <span className="font-mono text-xs font-semibold">{t.tagEpc}</span>
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant="outline" className="gap-1 text-[10px] font-medium">
                            <TypeIcon className="w-3 h-3" />{meta.label}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-xs font-medium">{t.vehiclePlate ?? "—"}</td>
                        <td className="px-4 py-3 text-xs">
                          {t.walletId ? (
                            <span className="inline-flex items-center gap-1 text-emerald-700">
                              <Wallet className="w-3 h-3" /> #{t.walletId}
                            </span>
                          ) : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-4 py-3">
                          <span className={cn("text-[10px] px-2 py-0.5 rounded-full border font-medium capitalize",
                            STATUS_STYLES[t.status] ?? "bg-muted text-muted-foreground border-border")}>
                            {t.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">{fmtDate(t.issuedAt)}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1 justify-end">
                            {t.status !== "active" && t.status !== "decommissioned" && (
                              <Button size="sm" variant="ghost" title="Activate"
                                className="h-7 w-7 p-0 text-emerald-600 hover:bg-emerald-50"
                                onClick={() => setConfirm({ action: "activate", tagEpc: t.tagEpc })}>
                                <CheckCircle2 className="w-3.5 h-3.5" />
                              </Button>
                            )}
                            {t.status === "active" && (
                              <Button size="sm" variant="ghost" title="Suspend"
                                className="h-7 w-7 p-0 text-amber-600 hover:bg-amber-50"
                                onClick={() => setConfirm({ action: "suspend", tagEpc: t.tagEpc })}>
                                <PauseCircle className="w-3.5 h-3.5" />
                              </Button>
                            )}
                            {t.status !== "lost" && t.status !== "decommissioned" && (
                              <Button size="sm" variant="ghost" title="Report lost"
                                className="h-7 w-7 p-0 text-red-500 hover:bg-red-50"
                                onClick={() => setConfirm({ action: "reportLost", tagEpc: t.tagEpc })}>
                                <AlertTriangle className="w-3.5 h-3.5" />
                              </Button>
                            )}
                            {t.status !== "decommissioned" && (
                              <>
                                <Button size="sm" variant="ghost" title="Replace tag"
                                  className="h-7 w-7 p-0 text-violet-600 hover:bg-violet-50"
                                  onClick={() => { setReplaceTag(t.tagEpc); setReplaceEpc(""); }}>
                                  <Repeat className="w-3.5 h-3.5" />
                                </Button>
                                <Button size="sm" variant="ghost" title="Link wallet"
                                  className="h-7 w-7 p-0 text-sky-600 hover:bg-sky-50"
                                  onClick={() => { setLinkTag(t.tagEpc); setLinkWalletId(t.walletId ? String(t.walletId) : ""); }}>
                                  <Link2 className="w-3.5 h-3.5" />
                                </Button>
                                <Button size="sm" variant="ghost" title="Decommission"
                                  className="h-7 w-7 p-0 text-slate-500 hover:bg-slate-100"
                                  onClick={() => setConfirm({ action: "decommission", tagEpc: t.tagEpc })}>
                                  <Ban className="w-3.5 h-3.5" />
                                </Button>
                              </>
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

          {/* Pagination */}
          {total > PAGE_SIZE && (
            <div className="p-3 border-t border-border flex items-center justify-between text-xs text-muted-foreground">
              <span>Page {page} of {totalPages} · {total.toLocaleString()} tags</span>
              <div className="flex gap-1.5">
                <Button size="sm" variant="outline" className="h-7 w-7 p-0"
                  disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
                  <ChevronLeft className="w-3.5 h-3.5" />
                </Button>
                <Button size="sm" variant="outline" className="h-7 w-7 p-0"
                  disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
                  <ChevronRight className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Issue New Tag dialog ── */}
      <Dialog open={issueOpen} onOpenChange={setIssueOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Issue New Tag</DialogTitle>
            <DialogDescription>
              Register a 24-character hex EPC and bind it to a vehicle or wallet.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="issue-epc" className="text-xs">Tag EPC (24 hex chars)</Label>
              <Input id="issue-epc" value={issueEpc}
                onChange={e => setIssueEpc(e.target.value.toUpperCase().replace(/[^0-9A-F]/g, "").slice(0, 24))}
                placeholder="E20034120183020019750AB1" className="font-mono uppercase" />
              {issueEpc && !issueEpcValid && (
                <p className="text-[11px] text-red-600">EPC must be exactly 24 hexadecimal characters ({issueEpc.length}/24).</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Tag Type</Label>
              <Select value={issueType} onValueChange={v => setIssueType(v as TagType)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TAG_TYPES.map(t => (
                    <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="issue-plate" className="text-xs">Vehicle Plate (optional)</Label>
                <Input id="issue-plate" value={issuePlate} onChange={e => setIssuePlate(e.target.value.toUpperCase())}
                  placeholder="LAG-123-XY" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="issue-wallet" className="text-xs">Wallet ID (optional)</Label>
                <Input id="issue-wallet" value={issueWalletId} inputMode="numeric"
                  onChange={e => setIssueWalletId(e.target.value.replace(/\D/g, ""))} placeholder="e.g. 42" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIssueOpen(false)}>Cancel</Button>
            <Button className="bg-emerald-600 hover:bg-emerald-700 gap-1.5"
              disabled={!issueEpcValid || issueMutation.isPending}
              onClick={() => issueMutation.mutate({
                tagEpc: normalizeEpc(issueEpc),
                tagType: issueType,
                vehiclePlate: issuePlate.trim() || undefined,
                walletId: issueWalletId ? parseInt(issueWalletId) : undefined,
              })}>
              {issueMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Issue Tag
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
                  <span className="font-mono text-xs font-semibold break-all">{confirm.tagEpc}</span>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setConfirm(null)}>Cancel</Button>
                  <Button className={cn("gap-1.5", meta.cls)} disabled={pendingAction}
                    onClick={() => confirmMutation[confirm.action].mutate({ tagEpc: confirm.tagEpc })}>
                    {pendingAction ? <Loader2 className="w-4 h-4 animate-spin" /> : <Icon className="w-4 h-4" />}
                    {meta.cta}
                  </Button>
                </DialogFooter>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* ── Replace tag dialog ── */}
      <Dialog open={!!replaceTag} onOpenChange={(o) => { if (!o) { setReplaceTag(null); setReplaceEpc(""); } }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Repeat className="w-5 h-5 text-violet-600" /> Replace Tag
            </DialogTitle>
            <DialogDescription>
              The old tag will be marked as replaced and the new tag takes over its wallet binding.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="px-3 py-2 bg-muted rounded-lg">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Old EPC</div>
              <span className="font-mono text-xs font-semibold break-all">{replaceTag}</span>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="replace-epc" className="text-xs">New Tag EPC (24 hex chars)</Label>
              <Input id="replace-epc" value={replaceEpc}
                onChange={e => setReplaceEpc(e.target.value.toUpperCase().replace(/[^0-9A-F]/g, "").slice(0, 24))}
                placeholder="E20034120183020019750AB1" className="font-mono uppercase" />
              {replaceEpc && !replaceEpcValid && (
                <p className="text-[11px] text-red-600">EPC must be exactly 24 hexadecimal characters ({replaceEpc.length}/24).</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setReplaceTag(null); setReplaceEpc(""); }}>Cancel</Button>
            <Button className="bg-violet-600 hover:bg-violet-700 gap-1.5"
              disabled={!replaceEpcValid || replaceMutation.isPending}
              onClick={() => replaceTag && replaceMutation.mutate({
                oldTagEpc: replaceTag,
                newTagEpc: normalizeEpc(replaceEpc),
              })}>
              {replaceMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Repeat className="w-4 h-4" />}
              Replace
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Link wallet dialog ── */}
      <Dialog open={!!linkTag} onOpenChange={(o) => { if (!o) { setLinkTag(null); setLinkWalletId(""); } }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Link2 className="w-5 h-5 text-sky-600" /> Link Wallet
            </DialogTitle>
            <DialogDescription>
              Bind this tag to a wallet so toll charges debit the right balance.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="px-3 py-2 bg-muted rounded-lg">
              <span className="font-mono text-xs font-semibold break-all">{linkTag}</span>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="link-wallet" className="text-xs">Wallet ID</Label>
              <Input id="link-wallet" value={linkWalletId} inputMode="numeric"
                onChange={e => setLinkWalletId(e.target.value.replace(/\D/g, ""))} placeholder="e.g. 42" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setLinkTag(null); setLinkWalletId(""); }}>Cancel</Button>
            <Button className="bg-sky-600 hover:bg-sky-700 gap-1.5"
              disabled={!linkWalletId || linkWalletMutation.isPending}
              onClick={() => linkTag && linkWalletMutation.mutate({ tagEpc: linkTag, walletId: parseInt(linkWalletId) })}>
              {linkWalletMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
              Link Wallet
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PortalLayout>
  );
}
