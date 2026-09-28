/**
 * NigerianPass Application Status Page
 * Design: Premium Civic — Navy authority base, Sora + Nunito Sans
 *
 * Features:
 *  - Reference-number lookup (mock + real API)
 *  - Live WebSocket status push via useKycStatusPush
 *  - Animated status banner that updates in real time
 *  - Step-by-step progress timeline
 *  - KYC score bar
 *  - Rejection reason / approval note
 *  - Resubmit CTA for rejected applications
 */
import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import {
  Search, CheckCircle2, Clock, XCircle, Eye, User, Car, Building2,
  AlertCircle, RefreshCw, MessageSquare, Loader2, Wifi, WifiOff,
  Radio, Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import PortalLayout from "@/components/PortalLayout";
import { useKycStatusPush, type KycStatus, type KycStatusEvent } from "@/hooks/useKycStatusPush";
import { trpc } from "@/lib/trpc";

// ── Types ─────────────────────────────────────────────────────────────────────
type AppType = "driver_kyc" | "vehicle" | "fleet_kyb";

interface StatusStep {
  label: string;
  description: string;
  completed: boolean;
  active: boolean;
  timestamp?: string;
}

interface AppRecord {
  id: string;
  type: AppType;
  name: string;
  status: KycStatus;
  submittedAt: string;
  updatedAt: string;
  kycScore?: number;
  steps: StatusStep[];
  notes?: string;
}
const TYPE_CONFIG: Record<AppType, { label: string; icon: React.ElementType; color: string }> = {
  driver_kyc: { label: "Driver KYC", icon: User, color: "bg-blue-100 text-blue-700" },
  vehicle: { label: "Vehicle Registration", icon: Car, color: "bg-purple-100 text-purple-700" },
  fleet_kyb: { label: "Fleet KYB", icon: Building2, color: "bg-amber-100 text-amber-700" },
};

const STATUS_CONFIG: Record<KycStatus, { label: string; color: string; icon: React.ElementType }> = {
  pending: { label: "Pending", color: "text-muted-foreground bg-muted border-border", icon: Clock },
  under_review: { label: "Under Review", color: "text-blue-700 bg-blue-50 border-blue-200", icon: Eye },
  approved: { label: "Approved", color: "text-emerald-700 bg-emerald-50 border-emerald-200", icon: CheckCircle2 },
  rejected: { label: "Rejected", color: "text-red-700 bg-red-50 border-red-200", icon: XCircle },
};

// ── Live push banner ──────────────────────────────────────────────────────────
function LivePushBanner({
  event,
  isConnected,
  isPolling,
}: {
  event: KycStatusEvent | null;
  isConnected: boolean;
  isPolling: boolean;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (event) {
      setVisible(true);
      const t = setTimeout(() => setVisible(false), 8000);
      return () => clearTimeout(t);
    }
  }, [event]);

  return (
    <div className="space-y-2">
      {/* Connection indicator */}
      <div className="flex items-center gap-2 text-xs">
        {isConnected ? (
          <>
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
            </span>
            <Wifi className="w-3 h-3 text-emerald-600" />
            <span className="text-emerald-700 font-medium">Live updates active</span>
          </>
        ) : isPolling ? (
          <>
            <Radio className="w-3 h-3 text-blue-500 animate-pulse" />
            <span className="text-blue-600">Polling for updates every 15s</span>
          </>
        ) : (
          <>
            <WifiOff className="w-3 h-3 text-muted-foreground" />
            <span className="text-muted-foreground">Live updates unavailable — the status below is the latest fetched from the server. Refresh to retry.</span>
          </>
        )}
      </div>

      {/* Event toast */}
      <AnimatePresence>
        {visible && event && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.97 }}
            transition={{ duration: 0.25 }}
            className={cn(
              "flex items-start gap-3 p-3 rounded-xl border text-sm",
              event.status === "approved"
                ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                : event.status === "rejected"
                ? "bg-red-50 border-red-200 text-red-800"
                : "bg-blue-50 border-blue-200 text-blue-800"
            )}
          >
            <Sparkles className="w-4 h-4 mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold">{event.step_label}</div>
              <div className="text-xs opacity-80 mt-0.5">{event.step_description}</div>
            </div>
            <button onClick={() => setVisible(false)} className="ml-auto opacity-50 hover:opacity-100 text-xs">✕</button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function ApplicationStatus() {
  const [refInput, setRefInput] = useState("");
  const [searching, setSearching] = useState(false);
  const [record, setRecord] = useState<AppRecord | null>(null);
  const [notFound, setNotFound] = useState(false);

  // Live WebSocket push — only active once a record is loaded
  const { latestEvent, history: pushHistory, isConnected, isPolling, lastUpdated } =
    useKycStatusPush(record?.id);

  // Apply incoming push events to the record
  useEffect(() => {
    if (!latestEvent || !record) return;
    setRecord(prev => {
      if (!prev) return prev;
      const updatedStatus = latestEvent.status;
      const updatedSteps = prev.steps.map(step => {
        if (step.label === latestEvent.step_label) {
          return { ...step, completed: true, active: false, timestamp: new Date(latestEvent.timestamp).toLocaleTimeString() };
        }
        return step;
      });
      // Mark next step as active if status is still in-progress
      let foundActive = false;
      const finalSteps = updatedSteps.map(step => {
        if (!step.completed && !foundActive) {
          foundActive = true;
          return { ...step, active: updatedStatus !== "approved" && updatedStatus !== "rejected" };
        }
        return { ...step, active: false };
      });
      return {
        ...prev,
        status: updatedStatus,
        updatedAt: new Date(latestEvent.timestamp).toLocaleString(),
        kycScore: latestEvent.kyc_score ?? prev.kycScore,
        notes: latestEvent.notes ?? prev.notes,
        steps: finalSteps,
      };
    });

    // Show toast for status changes
    if (latestEvent.status === "approved") {
      toast.success(`Application ${record.id} approved!`, { description: latestEvent.step_description });
    } else if (latestEvent.status === "rejected") {
      toast.error(`Application ${record.id} rejected`, { description: latestEvent.notes });
    } else {
      toast.info(latestEvent.step_label, { description: latestEvent.step_description });
    }
  }, [latestEvent]); // eslint-disable-line react-hooks/exhaustive-deps

  const [, navigate] = useLocation();
  const utils = trpc.useUtils();

  const handleResubmit = () => {
    if (!record) return;
    const routes: Record<AppType, string> = {
      driver_kyc: "/onboarding/driver",
      vehicle: "/onboarding/vehicle",
      fleet_kyb: "/onboarding/fleet",
    };
    const path = routes[record.type];
    if (path) {
      navigate(path);
    } else {
      toast.error("Unknown application type");
    }
  };

  const handleSearch = async () => {
    if (!refInput.trim()) return;
    setSearching(true);
    setNotFound(false);
    setRecord(null);
    const refId = refInput.trim().toUpperCase();
    try {
      // Try real DB first
      const result = await utils.kyc.getApplicationStatus.fetch({ referenceId: refId });
      if (result) {
        // Map DB record to AppRecord shape with generated steps
        const steps = buildStepsFromStatus(result.type as AppType, result.status as KycStatus);
        setRecord({
          id: result.referenceId,
          type: result.type as AppType,
          name: result.referenceId,
          status: result.status as KycStatus,
          submittedAt: new Date(result.createdAt).toLocaleString(),
          updatedAt: new Date(result.updatedAt).toLocaleString(),
          kycScore: result.kycScore ?? undefined,
          steps,
          notes: result.reviewNotes ?? undefined,
        });
      } else {
        setNotFound(true);
        toast.error("Application reference not found");
      }
    } catch (err: unknown) {
      setNotFound(true);
      toast.error((err as Error)?.message ?? "Failed to look up application. Please try again.");
    }
    setSearching(false);
  };

  // Build step timeline from application type and current status
  function buildStepsFromStatus(type: AppType, status: KycStatus): StatusStep[] {
    const driverSteps = [
      { label: "Application Submitted", description: "Your KYC application was received" },
      { label: "Documents Verified", description: "Document analysis complete" },
      { label: "Liveness Check", description: "Biometric liveness verification" },
      { label: "NIMC Verification", description: "NIN verified against NIMC database" },
      { label: "Admin Review", description: "Under manual review by compliance team" },
      { label: "Account Activated", description: "NigerianPass account ready to use" },
    ];
    const vehicleSteps = [
      { label: "Registration Submitted", description: "Vehicle registration application received" },
      { label: "Documents Verified", description: "Registration certificate and insurance verified" },
      { label: "FRSC Verification", description: "Plate number verified via FRSC database" },
      { label: "Admin Approval", description: "Admin review and approval" },
      { label: "NFC Tag Issued", description: "Vehicle linked to driver wallet" },
    ];
    const fleetSteps = [
      { label: "KYB Submitted", description: "Fleet KYB application received" },
      { label: "CAC Verification", description: "Company registration verified" },
      { label: "Director Verification", description: "Director identity verified" },
      { label: "Compliance Review", description: "Compliance team review" },
      { label: "Fleet Activated", description: "Fleet account activated" },
    ];
    const rawSteps = type === "vehicle" ? vehicleSteps : type === "fleet_kyb" ? fleetSteps : driverSteps;
    const statusOrder = ["submitted", "under_review", "approved", "rejected", "requires_resubmission"];
    const currentIdx = status === "approved" ? rawSteps.length - 1 : status === "rejected" ? rawSteps.length - 2 : Math.min(statusOrder.indexOf(status), rawSteps.length - 2);
    return rawSteps.map((step, i) => ({
      ...step,
      completed: i < currentIdx || status === "approved",
      active: i === currentIdx && status !== "approved" && status !== "rejected",
    }));
  }

  return (
    <PortalLayout title="Application Status" subtitle="Track your KYC/KYB application progress in real time">
      <div className="max-w-2xl mx-auto p-4 md:p-6 lg:p-8 space-y-6">

        {/* ── Search ─────────────────────────────────────────────────────── */}
        <div className="bg-white rounded-2xl border border-border shadow-sm p-6">
          <h3 className="font-bold mb-1" style={{ fontFamily: "Sora, sans-serif" }}>Track Your Application</h3>
          <p className="text-sm text-muted-foreground mb-4">
            Enter the reference number from your submission confirmation SMS or email
          </p>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                value={refInput}
                onChange={e => setRefInput(e.target.value.toUpperCase())}
                onKeyDown={e => e.key === "Enter" && handleSearch()}
                placeholder="e.g. DRV-XKQP7 or VEH-M3NR2"
                className="pl-9 h-10 font-mono"
              />
            </div>
            <Button
              onClick={handleSearch}
              disabled={searching || !refInput.trim()}
              className="h-10 gap-2 bg-blue-600 hover:bg-blue-700"
            >
              {searching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              Track
            </Button>
          </div>
          <div className="mt-3 flex gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground">Try these samples:</span>
            {["DRV-XKQP7", "VEH-M3NR2", "FLT-B9WX4"].map(ref => (
              <button
                key={ref}
                onClick={() => setRefInput(ref)}
                className="text-xs text-primary underline underline-offset-2 font-mono hover:text-primary/80"
              >
                {ref}
              </button>
            ))}
          </div>
        </div>

        {/* ── Not found ──────────────────────────────────────────────────── */}
        {notFound && (
          <motion.div
            initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
            className="bg-red-50 border border-red-200 rounded-2xl p-6 text-center"
          >
            <AlertCircle className="w-10 h-10 text-red-400 mx-auto mb-3" />
            <h3 className="font-semibold text-red-800 mb-1">Application Not Found</h3>
            <p className="text-sm text-red-600">
              No application found for reference <span className="font-mono font-bold">{refInput}</span>.
              Please check the reference number and try again.
            </p>
          </motion.div>
        )}

        {/* ── Result ─────────────────────────────────────────────────────── */}
        {record && (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">

            {/* Live push banner */}
            <div className="bg-white rounded-2xl border border-border shadow-sm p-4">
              <LivePushBanner event={latestEvent} isConnected={isConnected} isPolling={isPolling} />
              {lastUpdated && (
                <p className="text-[10px] text-muted-foreground mt-2">
                  Last live update: {lastUpdated.toLocaleTimeString()}
                </p>
              )}
              {pushHistory.length > 0 && (
                <details className="mt-2">
                  <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                    {pushHistory.length} live event{pushHistory.length !== 1 ? "s" : ""} received this session
                  </summary>
                  <div className="mt-2 space-y-1.5 max-h-36 overflow-y-auto">
                    {pushHistory.map((evt, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs">
                        <span className={cn("w-1.5 h-1.5 rounded-full mt-1 shrink-0",
                          evt.status === "approved" ? "bg-emerald-500" :
                          evt.status === "rejected" ? "bg-red-500" : "bg-blue-500")} />
                        <div>
                          <span className="font-medium text-foreground">{evt.step_label}</span>
                          <span className="text-muted-foreground ml-1.5">
                            {new Date(evt.timestamp).toLocaleTimeString()}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>

            {/* Header Card */}
            <div className="bg-white rounded-2xl border border-border shadow-sm p-5">
              <div className="flex items-start gap-4">
                <div className={cn("w-12 h-12 rounded-xl flex items-center justify-center shrink-0", TYPE_CONFIG[record.type].color)}>
                  {(() => { const Icon = TYPE_CONFIG[record.type].icon; return <Icon className="w-6 h-6" />; })()}
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <h3 className="font-bold text-lg" style={{ fontFamily: "Sora, sans-serif" }}>{record.name}</h3>
                    <AnimatePresence mode="wait">
                      <motion.span
                        key={record.status}
                        initial={{ scale: 0.85, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0.85, opacity: 0 }}
                        className={cn("text-xs px-2.5 py-1 rounded-full border font-semibold flex items-center gap-1", STATUS_CONFIG[record.status].color)}
                      >
                        {(() => { const Icon = STATUS_CONFIG[record.status].icon; return <Icon className="w-3.5 h-3.5" />; })()}
                        {STATUS_CONFIG[record.status].label}
                      </motion.span>
                    </AnimatePresence>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                    <span className="font-mono font-medium">{record.id}</span>
                    <span>·</span>
                    <span>{TYPE_CONFIG[record.type].label}</span>
                    <span>·</span>
                    <span>Submitted {record.submittedAt}</span>
                    <span>·</span>
                    <span>Updated {record.updatedAt}</span>
                  </div>
                  {record.kycScore !== undefined && (
                    <div className="mt-2 flex items-center gap-2">
                      <div className="text-xs text-muted-foreground">KYC Score:</div>
                      <motion.div
                        key={record.kycScore}
                        initial={{ scale: 1.2 }}
                        animate={{ scale: 1 }}
                        className={cn("text-sm font-bold",
                          record.kycScore >= 80 ? "text-emerald-600" :
                          record.kycScore >= 60 ? "text-amber-600" : "text-red-600")}
                      >
                        {record.kycScore}/100
                      </motion.div>
                      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden max-w-24">
                        <motion.div
                          className={cn("h-full rounded-full",
                            record.kycScore >= 80 ? "bg-emerald-500" :
                            record.kycScore >= 60 ? "bg-amber-500" : "bg-red-500")}
                          initial={{ width: 0 }}
                          animate={{ width: `${record.kycScore}%` }}
                          transition={{ duration: 0.6, ease: "easeOut" }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Progress Steps */}
            <div className="bg-white rounded-2xl border border-border shadow-sm p-5">
              <h4 className="font-semibold text-sm mb-4">Application Progress</h4>
              <div className="space-y-0">
                {record.steps.map((step, i) => (
                  <motion.div
                    key={step.label}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.05 }}
                    className="flex gap-3"
                  >
                    <div className="flex flex-col items-center">
                      <div className={cn(
                        "w-7 h-7 rounded-full flex items-center justify-center shrink-0 border-2 transition-all duration-500",
                        step.completed && !step.active ? "bg-emerald-500 border-emerald-500 text-white" :
                        step.active ? "bg-blue-500 border-blue-500 text-white" :
                        record.status === "rejected" && i === record.steps.length - 1 ? "bg-red-500 border-red-500 text-white" :
                        "bg-background border-border text-muted-foreground"
                      )}>
                        {step.completed && !step.active ? <CheckCircle2 className="w-4 h-4" /> :
                         step.active ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> :
                         record.status === "rejected" && i === record.steps.length - 1 ? <XCircle className="w-4 h-4" /> :
                         <span className="text-[10px] font-bold">{i + 1}</span>}
                      </div>
                      {i < record.steps.length - 1 && (
                        <div className={cn("w-0.5 flex-1 my-1 min-h-6 transition-colors duration-500",
                          step.completed ? "bg-emerald-300" : "bg-border")} />
                      )}
                    </div>
                    <div className="pb-4 flex-1">
                      <div className="flex items-center justify-between">
                        <span className={cn("text-sm font-medium",
                          step.active ? "text-blue-700" :
                          step.completed ? "text-foreground" : "text-muted-foreground"
                        )}>
                          {step.label}
                        </span>
                        {step.timestamp && (
                          <span className="text-[10px] text-muted-foreground">{step.timestamp}</span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">{step.description}</p>
                    </div>
                  </motion.div>
                ))}
              </div>
            </div>

            {/* Notes */}
            <AnimatePresence>
              {record.notes && (
                <motion.div
                  key="notes"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={cn("rounded-2xl border p-4",
                    record.status === "approved" ? "bg-emerald-50 border-emerald-200" :
                    record.status === "rejected" ? "bg-red-50 border-red-200" : "bg-blue-50 border-blue-200")}
                >
                  <div className="flex items-start gap-2">
                    <MessageSquare className={cn("w-4 h-4 mt-0.5 shrink-0",
                      record.status === "approved" ? "text-emerald-600" :
                      record.status === "rejected" ? "text-red-600" : "text-blue-600")} />
                    <div>
                      <div className={cn("text-xs font-semibold uppercase tracking-wide mb-1",
                        record.status === "approved" ? "text-emerald-700" :
                        record.status === "rejected" ? "text-red-700" : "text-blue-700")}>
                        {record.status === "approved" ? "Approval Note" :
                         record.status === "rejected" ? "Rejection Reason" : "Reviewer Note"}
                      </div>
                      <p className={cn("text-sm",
                        record.status === "approved" ? "text-emerald-800" :
                        record.status === "rejected" ? "text-red-800" : "text-blue-800")}>
                        {record.notes}
                      </p>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Resubmit CTA */}
            {record.status === "rejected" && (
              <div className="flex justify-center">
                <Button className="gap-2 bg-blue-600 hover:bg-blue-700" onClick={handleResubmit}>
                  <RefreshCw className="w-4 h-4" />
                  Resubmit Application
                </Button>
              </div>
            )}
          </motion.div>
        )}
      </div>
    </PortalLayout>
  );
}
