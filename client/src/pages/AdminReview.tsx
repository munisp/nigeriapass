import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import {
  CheckCircle2, XCircle, Clock, Eye, User, Car, Building2,
  Search, AlertCircle, Shield,
  ThumbsUp, ThumbsDown, RefreshCw, Star, Loader2, Wifi, WifiOff
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import PortalLayout from "@/components/PortalLayout";
import { trpc } from "@/lib/trpc";

// ── Types ─────────────────────────────────────────────────────────────────────

type AppStatus = "draft" | "submitted" | "under_review" | "approved" | "rejected" | "requires_resubmission";
type AppType = "driver" | "vehicle" | "fleet";

const TYPE_CONFIG: Record<AppType, { label: string; icon: React.ElementType; color: string }> = {
  driver: { label: "Driver KYC", icon: User, color: "bg-blue-100 text-blue-700" },
  vehicle: { label: "Vehicle", icon: Car, color: "bg-purple-100 text-purple-700" },
  fleet: { label: "Fleet KYB", icon: Building2, color: "bg-amber-100 text-amber-700" },
};

const STATUS_CONFIG: Record<AppStatus, { label: string; color: string; icon: React.ElementType }> = {
  draft: { label: "Draft", color: "bg-muted text-muted-foreground border-border", icon: Clock },
  submitted: { label: "Submitted", color: "bg-blue-50 text-blue-700 border-blue-200", icon: Clock },
  under_review: { label: "Under Review", color: "bg-indigo-50 text-indigo-700 border-indigo-200", icon: Eye },
  approved: { label: "Approved", color: "bg-emerald-50 text-emerald-700 border-emerald-200", icon: CheckCircle2 },
  rejected: { label: "Rejected", color: "bg-red-50 text-red-700 border-red-200", icon: XCircle },
  requires_resubmission: { label: "Resubmit", color: "bg-amber-50 text-amber-700 border-amber-200", icon: RefreshCw },
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function AdminReview() {
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<AppStatus | "all">("all");
  const [filterType, setFilterType] = useState<AppType | "all">("all");
  const [selectedRefId, setSelectedRefId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [resubmitNote, setResubmitNote] = useState("");
  const [kycScoreInput, setKycScoreInput] = useState<string>("");
  const [page, setPage] = useState(1);

  const utils = trpc.useUtils();

  // ── Queries ────────────────────────────────────────────────────────────────
  const { data: listData, isLoading: listLoading, error: listError } = trpc.admin.listApplications.useQuery({
    page,
    pageSize: 20,
    status: filterStatus !== "all" ? filterStatus : undefined,
    type: filterType !== "all" ? filterType : undefined,
    search: search.trim() || undefined,
  }, {
    refetchInterval: 30_000, // Poll every 30s for new submissions
  });

  const { data: statsData } = trpc.admin.stats.useQuery(undefined, {
    refetchInterval: 60_000,
  });

  const selectedApp = listData?.applications.find(a => a.referenceId === selectedRefId) ?? null;

  // ── Mutations ──────────────────────────────────────────────────────────────
  const approveMutation = trpc.admin.approveApplication.useMutation({
    onSuccess: (result) => {
      toast.success(`Application ${result.referenceId} approved — WebSocket push sent`);
      setSelectedRefId(null);
      utils.admin.listApplications.invalidate();
      utils.admin.stats.invalidate();
    },
    onError: (err) => {
      toast.error(`Approval failed: ${err.message}`);
    },
  });

  const rejectMutation = trpc.admin.rejectApplication.useMutation({
    onSuccess: (result) => {
      toast.success(`Application ${result.referenceId} rejected`);
      setSelectedRefId(null);
      setRejectReason("");
      utils.admin.listApplications.invalidate();
      utils.admin.stats.invalidate();
    },
    onError: (err) => {
      toast.error(`Rejection failed: ${err.message}`);
    },
  });

  const resubmitMutation = trpc.admin.requestResubmission.useMutation({
    onSuccess: (result) => {
      toast.success(`Resubmission requested for ${result.referenceId}`);
      setSelectedRefId(null);
      setResubmitNote("");
      utils.admin.listApplications.invalidate();
    },
    onError: (err) => {
      toast.error(`Request failed: ${err.message}`);
    },
  });

  const scoreMutation = trpc.admin.setKycScore.useMutation({
    onSuccess: () => {
      toast.success("KYC score updated");
      setKycScoreInput("");
      utils.admin.listApplications.invalidate();
    },
    onError: (err) => {
      toast.error(`Score update failed: ${err.message}`);
    },
  });

  // ── Handlers ───────────────────────────────────────────────────────────────
  const handleApprove = (referenceId: string) => {
    const score = kycScoreInput ? parseInt(kycScoreInput, 10) : undefined;
    approveMutation.mutate({ referenceId, kycScore: score });
  };

  const handleReject = (referenceId: string) => {
    if (!rejectReason.trim()) {
      toast.error("Please provide a rejection reason");
      return;
    }
    const score = kycScoreInput ? parseInt(kycScoreInput, 10) : undefined;
    rejectMutation.mutate({ referenceId, reviewNotes: rejectReason.trim(), kycScore: score });
  };

  const handleResubmit = (referenceId: string) => {
    if (!resubmitNote.trim()) {
      toast.error("Please describe what needs to be corrected");
      return;
    }
    resubmitMutation.mutate({ referenceId, reviewNotes: resubmitNote.trim() });
  };

  const handleSetScore = (referenceId: string) => {
    const score = parseInt(kycScoreInput, 10);
    if (isNaN(score) || score < 0 || score > 100) {
      toast.error("Score must be between 0 and 100");
      return;
    }
    scoreMutation.mutate({ referenceId, kycScore: score });
  };

  const isMutating = approveMutation.isPending || rejectMutation.isPending ||
    resubmitMutation.isPending || scoreMutation.isPending;

  // ── Stats ──────────────────────────────────────────────────────────────────
  const stats = statsData ?? {
    total: 0, pending: 0, requiresResubmission: 0, approved: 0, rejected: 0,
    approvalRate: 0, byType: { driver: 0, vehicle: 0, fleet: 0 }, recentActivity: []
  };

  return (
    <PortalLayout title="Admin Review" subtitle="KYC/KYB application review queue">
      <div className="p-4 md:p-6 lg:p-8 space-y-6">

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: "Pending", value: stats.pending, color: "text-muted-foreground", bg: "bg-muted" },
            { label: "Under Review", value: (listData?.applications ?? []).filter(a => a.status === "under_review").length, color: "text-indigo-700", bg: "bg-indigo-50 border border-indigo-200" },
            { label: "Approved", value: stats.approved, color: "text-emerald-700", bg: "bg-emerald-50 border border-emerald-200" },
            { label: "Rejected", value: stats.rejected, color: "text-red-700", bg: "bg-red-50 border border-red-200" },
          ].map(s => (
            <motion.div key={s.label} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
              className={cn("rounded-xl p-4 text-center", s.bg)}>
              <div className={cn("text-3xl font-bold", s.color)}>{s.value}</div>
              <div className="text-xs text-muted-foreground mt-1">{s.label}</div>
            </motion.div>
          ))}
        </div>

        {/* Filters */}
        <div className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex items-center gap-3 flex-wrap">
            <div className="relative flex-1 min-w-48">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }}
                placeholder="Search by name or reference ID..." className="pl-9 h-9" />
            </div>
            <div className="flex gap-1.5 flex-wrap">
              {(["all", "submitted", "under_review", "approved", "rejected", "requires_resubmission"] as const).map(s => (
                <button key={s} onClick={() => { setFilterStatus(s); setPage(1); }}
                  className={cn("px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-all",
                    filterStatus === s ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/80")}>
                  {s.replace(/_/g, " ")}
                </button>
              ))}
            </div>
            <div className="flex gap-1.5">
              {(["all", "driver", "vehicle", "fleet"] as const).map(t => (
                <button key={t} onClick={() => { setFilterType(t); setPage(1); }}
                  className={cn("px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-all",
                    filterType === t ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/80")}>
                  {t === "all" ? "All Types" : TYPE_CONFIG[t].label}
                </button>
              ))}
            </div>
          </div>

          {/* Loading / Error states */}
          {listLoading && (
            <div className="p-12 text-center text-muted-foreground">
              <Loader2 className="w-8 h-8 mx-auto mb-3 animate-spin opacity-50" />
              <p className="text-sm">Loading applications...</p>
            </div>
          )}

          {listError && (
            <div className="p-12 text-center">
              <WifiOff className="w-8 h-8 mx-auto mb-3 text-red-400" />
              <p className="text-sm text-red-600 font-medium">Failed to load applications</p>
              <p className="text-xs text-muted-foreground mt-1">{listError.message}</p>
              <Button size="sm" variant="outline" className="mt-3" onClick={() => utils.admin.listApplications.invalidate()}>
                <RefreshCw className="w-3.5 h-3.5 mr-1.5" />Retry
              </Button>
            </div>
          )}

          {/* Application List */}
          {!listLoading && !listError && (
            <div className="divide-y divide-border">
              {(listData?.applications ?? []).map(app => {
                const typeCfg = TYPE_CONFIG[app.type as AppType] ?? TYPE_CONFIG.driver;
                const statusCfg = STATUS_CONFIG[app.status as AppStatus] ?? STATUS_CONFIG.submitted;
                const StatusIcon = statusCfg.icon;
                const TypeIcon = typeCfg.icon;
                const isSelected = selectedRefId === app.referenceId;
                const isActionable = app.status === "submitted" || app.status === "under_review";

                return (
                  <div key={app.referenceId}>
                    <div className={cn("p-4 hover:bg-muted/30 transition-colors cursor-pointer", isSelected && "bg-muted/50")}
                      onClick={() => setSelectedRefId(isSelected ? null : app.referenceId)}>
                      <div className="flex items-center gap-4">
                        <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center shrink-0", typeCfg.color)}>
                          <TypeIcon className="w-5 h-5" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-sm">{(app.formData as Record<string, unknown>)?.firstName ? `${(app.formData as Record<string, unknown>).firstName} ${(app.formData as Record<string, unknown>).lastName ?? ""}`.trim() : `User #${app.userId}`}</span>
                            <span className={cn("text-[10px] px-2 py-0.5 rounded-full border font-medium flex items-center gap-1", statusCfg.color)}>
                              <StatusIcon className="w-3 h-3" />{statusCfg.label}
                            </span>
                          </div>
                          <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
                            <span>{app.referenceId}</span>
                            <span>·</span>
                            <span>{typeCfg.label}</span>
                            <span>·</span>
                            <span>Submitted {new Date(app.createdAt).toLocaleDateString()}</span>
                            {app.reviewedBy && <><span>·</span><span>Reviewed by Admin #{app.reviewedBy}</span></>}
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          {app.kycScore != null && (
                            <>
                              <div className={cn("text-lg font-bold",
                                app.kycScore >= 80 ? "text-emerald-600" : app.kycScore >= 60 ? "text-amber-600" : "text-red-600")}>
                                {app.kycScore}
                              </div>
                              <div className="text-[10px] text-muted-foreground">KYC Score</div>
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Expanded Detail Panel */}
                    <AnimatePresence>
                      {isSelected && (
                        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}
                          exit={{ opacity: 0, height: 0 }}
                          className="border-t border-border bg-muted/20 p-4 space-y-4">

                          {/* Review Notes */}
                          {app.reviewNotes && (
                            <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800">
                              <span className="font-semibold">Review notes: </span>{app.reviewNotes}
                            </div>
                          )}

                          {/* KYC Score setter */}
                          {isActionable && (
                            <div className="flex items-center gap-2">
                              <Star className="w-4 h-4 text-amber-500 shrink-0" />
                              <Input
                                type="number" min={0} max={100}
                                value={kycScoreInput}
                                onChange={e => setKycScoreInput(e.target.value)}
                                placeholder="Set KYC score (0–100)..."
                                className="h-8 text-sm w-48"
                              />
                              <Button size="sm" variant="outline" className="h-8 text-xs"
                                onClick={() => handleSetScore(app.referenceId)}
                                disabled={scoreMutation.isPending}>
                                {scoreMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Set Score"}
                              </Button>
                            </div>
                          )}

                          {/* Actions */}
                          {isActionable && (
                            <div className="space-y-3">
                              {/* Approve */}
                              <Button size="sm" className="gap-1.5 bg-emerald-600 hover:bg-emerald-700"
                                onClick={() => handleApprove(app.referenceId)}
                                disabled={isMutating}>
                                {approveMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ThumbsUp className="w-4 h-4" />}
                                Approve & Notify Applicant
                              </Button>

                              {/* Reject */}
                              <div className="flex gap-2">
                                <Input value={rejectReason} onChange={e => setRejectReason(e.target.value)}
                                  placeholder="Rejection reason (required)..." className="h-9 text-sm flex-1" />
                                <Button size="sm" variant="destructive" className="gap-1.5 shrink-0"
                                  onClick={() => handleReject(app.referenceId)}
                                  disabled={isMutating}>
                                  {rejectMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ThumbsDown className="w-4 h-4" />}
                                  Reject
                                </Button>
                              </div>

                              {/* Request Resubmission */}
                              <div className="flex gap-2">
                                <Input value={resubmitNote} onChange={e => setResubmitNote(e.target.value)}
                                  placeholder="What needs to be corrected? (required)..." className="h-9 text-sm flex-1" />
                                <Button size="sm" variant="outline" className="gap-1.5 shrink-0"
                                  onClick={() => handleResubmit(app.referenceId)}
                                  disabled={isMutating}>
                                  {resubmitMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                                  Request Resubmission
                                </Button>
                              </div>
                            </div>
                          )}

                          {/* Final status badge */}
                          {!isActionable && (
                            <div className={cn("inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border", statusCfg.color)}>
                              <StatusIcon className="w-4 h-4" />
                              This application has been {app.status.replace(/_/g, " ")}
                            </div>
                          )}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                );
              })}
            </div>
          )}

          {!listLoading && !listError && (listData?.applications ?? []).length === 0 && (
            <div className="p-12 text-center text-muted-foreground">
              <Shield className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No applications match your filters</p>
            </div>
          )}

          {/* Pagination */}
          {listData && listData.pagination.totalPages > 1 && (
            <div className="p-4 border-t border-border flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                Page {page} of {listData.pagination.totalPages} · {listData.pagination.total} total
              </span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
                  Previous
                </Button>
                <Button size="sm" variant="outline" disabled={page >= listData.pagination.totalPages} onClick={() => setPage(p => p + 1)}>
                  Next
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </PortalLayout>
  );
}
