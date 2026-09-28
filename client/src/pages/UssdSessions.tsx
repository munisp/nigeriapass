/**
 * USSD Sessions — Admin list with session replay
 * Displays all recorded *346# sessions with filterable table and
 * row-expansion to replay the exact menu path taken by each caller.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import PortalLayout from "@/components/PortalLayout";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Phone, CheckCheck, XCircle, ChevronDown, ChevronRight,
  RefreshCw, Search, Clock, Hash,
} from "lucide-react";
import { toast } from "sonner";

const MENU_STEP_COLORS: Record<string, string> = {
  "1": "bg-sky-50 text-sky-700 border-sky-200",
  "2": "bg-violet-50 text-violet-700 border-violet-200",
  "3": "bg-teal-50 text-teal-700 border-teal-200",
  "4": "bg-orange-50 text-orange-700 border-orange-200",
  "5": "bg-pink-50 text-pink-700 border-pink-200",
  "0": "bg-muted text-muted-foreground border-border",
};

function SessionReplay({ sessionId }: { sessionId: string }) {
  const { data, isLoading, error } = trpc.ussd.getSessionDetail.useQuery({ sessionId });

  if (isLoading) {
    return (
      <div className="p-4 space-y-2 animate-pulse">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-8 bg-muted rounded-lg" />
        ))}
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {error?.message ?? "Session detail unavailable."}
      </div>
    );
  }

  const { steps, summary, durationMs } = data;

  return (
    <div className="px-4 pb-4 pt-2 space-y-3">
      {/* Summary row */}
      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Phone className="w-3 h-3" /> {summary.phone}
        </span>
        <span className="flex items-center gap-1">
          <Hash className="w-3 h-3" /> {summary.interactionCount} interactions
        </span>
        {durationMs != null && (
          <span className="flex items-center gap-1">
            <Clock className="w-3 h-3" /> {Math.round(durationMs / 1000)}s
          </span>
        )}
        <span className={cn(
          "flex items-center gap-1 font-medium",
          summary.completed ? "text-emerald-600" : "text-amber-600"
        )}>
          {summary.completed ? <CheckCheck className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
          {summary.completed ? "Completed" : "Abandoned"}
        </span>
      </div>

      {/* Step-by-step replay */}
      {steps.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {steps.map((step, i) => (
            <div key={i} className="flex items-center gap-1">
              <span className={cn(
                "inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border text-xs font-medium",
                MENU_STEP_COLORS[step.input] ?? "bg-muted text-muted-foreground border-border"
              )}>
                <span className="text-[10px] text-muted-foreground font-normal">Step {step.step}:</span>
                {step.input} — {step.label}
              </span>
              {i < steps.length - 1 && (
                <ChevronRight className="w-3 h-3 text-muted-foreground flex-shrink-0" />
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground italic">
          No menu path recorded (session abandoned at root menu).
        </div>
      )}
    </div>
  );
}

export default function UssdSessions() {
  const [days, setDays] = useState(30);
  const [completedFilter, setCompletedFilter] = useState<boolean | undefined>(undefined);
  const [phoneSearch, setPhoneSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isLoading, refetch, isFetching } = trpc.ussd.getSessionList.useQuery(
    {
      days,
      completed: completedFilter,
      phone: phoneSearch || undefined,
      limit: 100,
      offset: 0,
    },
    { refetchOnWindowFocus: false }
  );

  const sessions = data?.sessions ?? [];

  return (
    <PortalLayout
      title="USSD Sessions"
      subtitle="Recorded *346# session history with menu path replay"
    >
      <div className="p-4 md:p-6 lg:p-8 space-y-5">

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Days range */}
          <div className="flex items-center gap-1">
            {([7, 14, 30, 90] as const).map(d => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={cn(
                  "px-3 py-1.5 text-xs font-medium rounded-lg border transition-all",
                  days === d
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-white text-muted-foreground border-border hover:border-primary/50"
                )}
              >
                {d}d
              </button>
            ))}
          </div>

          {/* Completed filter */}
          <div className="flex items-center gap-1">
            {[
              { label: "All", value: undefined },
              { label: "Completed", value: true },
              { label: "Abandoned", value: false },
            ].map(f => (
              <button
                key={String(f.value)}
                onClick={() => setCompletedFilter(f.value)}
                className={cn(
                  "px-3 py-1.5 text-xs font-medium rounded-lg border transition-all",
                  completedFilter === f.value
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-white text-muted-foreground border-border hover:border-primary/50"
                )}
              >
                {f.label}
              </button>
            ))}
          </div>

          {/* Phone search */}
          <div className="relative flex-1 min-w-[180px] max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              type="text"
              placeholder="Filter by phone…"
              value={phoneSearch}
              onChange={e => setPhoneSearch(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 text-xs border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 bg-white"
            />
          </div>

          <Button
            variant="outline" size="sm" className="gap-1.5 text-xs ml-auto"
            onClick={() => { refetch(); toast.info("Refreshed"); }}
            disabled={isFetching}
          >
            <RefreshCw className={cn("w-3.5 h-3.5", isFetching && "animate-spin")} />
            Refresh
          </Button>
        </div>

        {/* Table */}
        <div className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="text-left py-3 px-4 text-xs font-semibold text-muted-foreground w-8" />
                  <th className="text-left py-3 px-4 text-xs font-semibold text-muted-foreground">Phone</th>
                  <th className="text-left py-3 px-4 text-xs font-semibold text-muted-foreground">Status</th>
                  <th className="text-left py-3 px-4 text-xs font-semibold text-muted-foreground">Interactions</th>
                  <th className="text-left py-3 px-4 text-xs font-semibold text-muted-foreground">Duration</th>
                  <th className="text-left py-3 px-4 text-xs font-semibold text-muted-foreground">Started</th>
                  <th className="text-left py-3 px-4 text-xs font-semibold text-muted-foreground">Menu Path</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  Array.from({ length: 8 }).map((_, i) => (
                    <tr key={i} className="border-b border-border animate-pulse">
                      {Array.from({ length: 7 }).map((_, j) => (
                        <td key={j} className="py-3 px-4">
                          <div className="h-4 bg-muted rounded w-full" />
                        </td>
                      ))}
                    </tr>
                  ))
                ) : sessions.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-12 text-center text-sm text-muted-foreground">
                      No USSD sessions found for the selected filters.
                      <br />
                      <span className="text-xs">Sessions are recorded when users dial *346#.</span>
                    </td>
                  </tr>
                ) : (
                  sessions.map(session => {
                    const isExpanded = expandedId === session.sessionId;
                    return (
                      <>
                        <tr
                          key={session.sessionId}
                          className={cn(
                            "border-b border-border transition-colors cursor-pointer",
                            isExpanded ? "bg-primary/5" : "hover:bg-muted/30"
                          )}
                          onClick={() => setExpandedId(isExpanded ? null : session.sessionId)}
                        >
                          <td className="py-3 px-4">
                            {isExpanded
                              ? <ChevronDown className="w-4 h-4 text-primary" />
                              : <ChevronRight className="w-4 h-4 text-muted-foreground" />
                            }
                          </td>
                          <td className="py-3 px-4 font-mono text-xs">{session.phoneNumber}</td>
                          <td className="py-3 px-4">
                            <span className={cn(
                              "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium",
                              session.completed
                                ? "bg-emerald-50 text-emerald-700"
                                : "bg-amber-50 text-amber-700"
                            )}>
                              {session.completed
                                ? <><CheckCheck className="w-3 h-3" /> Completed</>
                                : <><XCircle className="w-3 h-3" /> Abandoned</>
                              }
                            </span>
                          </td>
                          <td className="py-3 px-4 text-muted-foreground">{session.interactionCount}</td>
                          <td className="py-3 px-4 text-muted-foreground">
                            {session.durationSeconds != null ? `${session.durationSeconds}s` : "—"}
                          </td>
                          <td className="py-3 px-4 text-muted-foreground text-xs">
                            {new Date(session.startedAt).toLocaleString()}
                          </td>
                          <td className="py-3 px-4 font-mono text-xs text-muted-foreground">
                            {session.menuPath ?? "—"}
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr key={`${session.sessionId}-detail`} className="bg-primary/5 border-b border-border">
                            <td colSpan={7} className="p-0">
                              <SessionReplay sessionId={session.sessionId} />
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          {sessions.length > 0 && (
            <div className="px-4 py-3 border-t border-border text-xs text-muted-foreground">
              Showing {sessions.length} session{sessions.length !== 1 ? "s" : ""} from the last {days} days
            </div>
          )}
        </div>

      </div>
    </PortalLayout>
  );
}
