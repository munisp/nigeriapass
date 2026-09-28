import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import {
  User, Shield, ShieldCheck, Search, ChevronDown, ChevronUp,
  Loader2, RefreshCw, Crown, UserX, CheckCircle2, Clock,
  XCircle, AlertCircle, Mail, Key, Calendar, Activity
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import PortalLayout from "@/components/PortalLayout";
import { trpc } from "@/lib/trpc";

// ── Types ─────────────────────────────────────────────────────────────────────

type UserRole = "user" | "admin";

const ROLE_CONFIG: Record<UserRole, { label: string; color: string; icon: React.ElementType }> = {
  admin: { label: "Admin", color: "bg-purple-100 text-purple-700 border-purple-200", icon: ShieldCheck },
  user: { label: "User", color: "bg-muted text-muted-foreground border-border", icon: User },
};

const LOGIN_METHOD_CONFIG: Record<string, { label: string; color: string }> = {
  manus: { label: "Manus OAuth", color: "text-blue-600" },
  otp: { label: "SMS OTP", color: "text-emerald-600" },
  password: { label: "Password", color: "text-amber-600" },
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function AdminUsers() {
  const [search, setSearch] = useState("");
  const [filterRole, setFilterRole] = useState<UserRole | "all">("all");
  const [page, setPage] = useState(1);
  const [expandedUserId, setExpandedUserId] = useState<number | null>(null);
  const [confirmAction, setConfirmAction] = useState<{ userId: number; name: string; newRole: UserRole } | null>(null);

  const utils = trpc.useUtils();

  // ── Queries ────────────────────────────────────────────────────────────────
  const { data: listData, isLoading, error } = trpc.admin.listUsers.useQuery({
    page,
    pageSize: 20,
    search: search.trim() || undefined,
    role: filterRole !== "all" ? filterRole : undefined,
  }, {
    refetchInterval: 60_000,
  });

  const { data: userStats, isLoading: statsLoading } = trpc.admin.getUserStats.useQuery(
    { userId: expandedUserId! },
    { enabled: expandedUserId !== null }
  );

  // ── Mutations ──────────────────────────────────────────────────────────────
  const setRoleMutation = trpc.admin.setUserRole.useMutation({
    onSuccess: (result) => {
      const label = result.newRole === "admin" ? "promoted to Admin" : "demoted to User";
      toast.success(`User #${result.userId} ${label}`);
      setConfirmAction(null);
      utils.admin.listUsers.invalidate();
    },
    onError: (err) => {
      toast.error(`Role change failed: ${err.message}`);
      setConfirmAction(null);
    },
  });

  const handleRoleChange = (userId: number, name: string, currentRole: UserRole) => {
    const newRole: UserRole = currentRole === "admin" ? "user" : "admin";
    setConfirmAction({ userId, name, newRole });
  };

  const confirmRoleChange = () => {
    if (!confirmAction) return;
    setRoleMutation.mutate({ userId: confirmAction.userId, role: confirmAction.newRole });
  };

  const pagination = listData?.pagination;

  return (
    <PortalLayout title="User Management" subtitle="Manage user accounts and admin roles">
      <div className="p-4 md:p-6 lg:p-8 space-y-6">

        {/* Summary stats */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
            className="rounded-xl p-4 text-center bg-muted">
            <div className="text-3xl font-bold text-foreground">{pagination?.total ?? "—"}</div>
            <div className="text-xs text-muted-foreground mt-1">Total Users</div>
          </motion.div>
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}
            className="rounded-xl p-4 text-center bg-purple-50 border border-purple-200">
            <div className="text-3xl font-bold text-purple-700">
              {(listData?.users ?? []).filter(u => u.role === "admin").length}
            </div>
            <div className="text-xs text-muted-foreground mt-1">Admins (this page)</div>
          </motion.div>
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}
            className="rounded-xl p-4 text-center bg-emerald-50 border border-emerald-200">
            <div className="text-3xl font-bold text-emerald-700">
              {(listData?.users ?? []).filter(u => {
                const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
                return u.lastSignedIn > dayAgo;
              }).length}
            </div>
            <div className="text-xs text-muted-foreground mt-1">Active Today</div>
          </motion.div>
        </div>

        {/* Filters */}
        <div className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex items-center gap-3 flex-wrap">
            <div className="relative flex-1 min-w-48">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }}
                placeholder="Search by name, email, or ID..." className="pl-9 h-9" />
            </div>
            <div className="flex gap-1.5">
              {(["all", "user", "admin"] as const).map(r => (
                <button key={r} onClick={() => { setFilterRole(r); setPage(1); }}
                  className={cn("px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-all",
                    filterRole === r ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/80")}>
                  {r === "all" ? "All Roles" : r.charAt(0).toUpperCase() + r.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {/* Loading / Error */}
          {isLoading && (
            <div className="p-12 text-center text-muted-foreground">
              <Loader2 className="w-8 h-8 mx-auto mb-3 animate-spin opacity-50" />
              <p className="text-sm">Loading users...</p>
            </div>
          )}

          {error && (
            <div className="p-12 text-center">
              <AlertCircle className="w-8 h-8 mx-auto mb-3 text-red-400" />
              <p className="text-sm text-red-600 font-medium">Failed to load users</p>
              <p className="text-xs text-muted-foreground mt-1">{error.message}</p>
              <Button size="sm" variant="outline" className="mt-3" onClick={() => utils.admin.listUsers.invalidate()}>
                <RefreshCw className="w-3.5 h-3.5 mr-1.5" />Retry
              </Button>
            </div>
          )}

          {/* User List */}
          {!isLoading && !error && (
            <div className="divide-y divide-border">
              {(listData?.users ?? []).map(user => {
                const roleCfg = ROLE_CONFIG[user.role as UserRole] ?? ROLE_CONFIG.user;
                const RoleIcon = roleCfg.icon;
                const loginCfg = LOGIN_METHOD_CONFIG[user.loginMethod ?? "manus"] ?? LOGIN_METHOD_CONFIG.manus;
                const isExpanded = expandedUserId === user.id;
                const isCurrentUser = false; // We don't have current user id here easily

                return (
                  <div key={user.id}>
                    <div
                      className={cn("p-4 hover:bg-muted/30 transition-colors cursor-pointer", isExpanded && "bg-muted/50")}
                      onClick={() => setExpandedUserId(isExpanded ? null : user.id)}
                    >
                      <div className="flex items-center gap-4">
                        {/* Avatar */}
                        <div className={cn("w-10 h-10 rounded-full flex items-center justify-center shrink-0 font-semibold text-sm",
                          user.role === "admin" ? "bg-purple-100 text-purple-700" : "bg-muted text-muted-foreground")}>
                          {user.name ? user.name.charAt(0).toUpperCase() : "#"}
                        </div>

                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-sm">{user.name ?? `User #${user.id}`}</span>
                            <span className={cn("text-[10px] px-2 py-0.5 rounded-full border font-medium flex items-center gap-1", roleCfg.color)}>
                              <RoleIcon className="w-3 h-3" />{roleCfg.label}
                            </span>
                          </div>
                          <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground flex-wrap">
                            {user.email && <span className="flex items-center gap-1"><Mail className="w-3 h-3" />{user.email}</span>}
                            <span className={cn("flex items-center gap-1", loginCfg.color)}>
                              <Key className="w-3 h-3" />{loginCfg.label}
                            </span>
                            <span className="flex items-center gap-1">
                              <Calendar className="w-3 h-3" />
                              Joined {new Date(user.createdAt).toLocaleDateString()}
                            </span>
                            <span className="flex items-center gap-1">
                              <Activity className="w-3 h-3" />
                              Last seen {new Date(user.lastSignedIn).toLocaleDateString()}
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          {/* Role toggle button */}
                          <Button
                            size="sm"
                            variant={user.role === "admin" ? "destructive" : "outline"}
                            className={cn("h-7 text-xs gap-1", user.role === "admin" ? "" : "border-purple-300 text-purple-700 hover:bg-purple-50")}
                            onClick={e => { e.stopPropagation(); handleRoleChange(user.id, user.name ?? `User #${user.id}`, user.role as UserRole); }}
                            disabled={setRoleMutation.isPending}
                          >
                            {user.role === "admin" ? (
                              <><UserX className="w-3 h-3" />Demote</>
                            ) : (
                              <><Crown className="w-3 h-3" />Promote</>
                            )}
                          </Button>
                          {isExpanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                        </div>
                      </div>
                    </div>

                    {/* Expanded: KYC application history */}
                    <AnimatePresence>
                      {isExpanded && (
                        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}
                          exit={{ opacity: 0, height: 0 }}
                          className="border-t border-border bg-muted/20 p-4">
                          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
                            KYC Application History
                          </div>
                          {statsLoading ? (
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                              <Loader2 className="w-4 h-4 animate-spin" />Loading applications...
                            </div>
                          ) : userStats?.applications.length === 0 ? (
                            <p className="text-sm text-muted-foreground">No KYC applications found for this user.</p>
                          ) : (
                            <div className="space-y-2">
                              {(userStats?.applications ?? []).map(app => {
                                const statusIcon = app.status === "approved" ? CheckCircle2
                                  : app.status === "rejected" ? XCircle
                                  : app.status === "requires_resubmission" ? AlertCircle
                                  : Clock;
                                const StatusIcon = statusIcon;
                                const statusColor = app.status === "approved" ? "text-emerald-600"
                                  : app.status === "rejected" ? "text-red-600"
                                  : app.status === "requires_resubmission" ? "text-amber-600"
                                  : "text-muted-foreground";
                                return (
                                  <div key={app.referenceId} className="flex items-center gap-3 p-2.5 rounded-lg bg-white border border-border text-sm">
                                    <StatusIcon className={cn("w-4 h-4 shrink-0", statusColor)} />
                                    <span className="font-mono text-xs text-muted-foreground">{app.referenceId}</span>
                                    <span className="capitalize text-xs">{app.type} KYC</span>
                                    <span className={cn("ml-auto text-xs capitalize font-medium", statusColor)}>
                                      {app.status.replace(/_/g, " ")}
                                    </span>
                                    <span className="text-xs text-muted-foreground">
                                      {new Date(app.createdAt).toLocaleDateString()}
                                    </span>
                                  </div>
                                );
                              })}
                              <p className="text-xs text-muted-foreground pt-1">
                                {userStats?.total} application{userStats?.total !== 1 ? "s" : ""} total
                              </p>
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

          {!isLoading && !error && (listData?.users ?? []).length === 0 && (
            <div className="p-12 text-center text-muted-foreground">
              <Shield className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No users match your filters</p>
            </div>
          )}

          {/* Pagination */}
          {pagination && pagination.totalPages > 1 && (
            <div className="p-4 border-t border-border flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                Page {page} of {pagination.totalPages} · {pagination.total} total
              </span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous</Button>
                <Button size="sm" variant="outline" disabled={page >= pagination.totalPages} onClick={() => setPage(p => p + 1)}>Next</Button>
              </div>
            </div>
          )}
        </div>

        {/* Confirm Role Change Dialog */}
        <AnimatePresence>
          {confirmAction && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
              onClick={() => setConfirmAction(null)}
            >
              <motion.div
                initial={{ scale: 0.95, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.95, opacity: 0 }}
                className="bg-white rounded-2xl p-6 max-w-sm w-full shadow-xl"
                onClick={e => e.stopPropagation()}
              >
                <div className={cn("w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-4",
                  confirmAction.newRole === "admin" ? "bg-purple-100" : "bg-red-100")}>
                  {confirmAction.newRole === "admin"
                    ? <Crown className="w-6 h-6 text-purple-700" />
                    : <UserX className="w-6 h-6 text-red-600" />}
                </div>
                <h3 className="text-lg font-semibold text-center mb-2">
                  {confirmAction.newRole === "admin" ? "Promote to Admin?" : "Demote to User?"}
                </h3>
                <p className="text-sm text-muted-foreground text-center mb-6">
                  {confirmAction.newRole === "admin"
                    ? `${confirmAction.name} will gain full admin access including KYC review, user management, and analytics.`
                    : `${confirmAction.name} will lose all admin privileges immediately.`}
                </p>
                <div className="flex gap-3">
                  <Button variant="outline" className="flex-1" onClick={() => setConfirmAction(null)}>
                    Cancel
                  </Button>
                  <Button
                    className={cn("flex-1", confirmAction.newRole === "admin" ? "bg-purple-600 hover:bg-purple-700" : "bg-red-600 hover:bg-red-700")}
                    onClick={confirmRoleChange}
                    disabled={setRoleMutation.isPending}
                  >
                    {setRoleMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Confirm"}
                  </Button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </PortalLayout>
  );
}
