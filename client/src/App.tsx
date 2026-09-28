import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { lazy, Suspense, useEffect } from "react";
import { Route, Switch, useLocation } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { DataSaverProvider } from "./contexts/DataSaverContext";
import DataSaverBanner from "./components/DataSaverBanner";
import NetworkStatusBar from "./components/NetworkStatusBar";
import PwaInstallBanner from "./components/PwaInstallBanner";
import MobileNav from "./components/MobileNav";
import { useServiceWorker } from "./hooks/useServiceWorker";
import { toast } from "sonner";

// ── Eager-loaded (critical path — always needed on first paint) ───────────────
import Landing from "./pages/Landing";
import NotFound from "./pages/NotFound";
import Login from "./pages/Login";

// ── Lazy-loaded chunks (split by route group) ─────────────────────────────────
// Each lazy() call creates a separate JS chunk that is only downloaded when
// the user navigates to that route. This reduces the initial bundle from
// ~2 MB to ~400 KB, cutting 2G load time from ~12s to ~4s.

// Onboarding group (~350 KB — react-hook-form, zod, liveness)
const DriverOnboarding   = lazy(() => import("./pages/DriverOnboarding"));
const VehicleRegistration = lazy(() => import("./pages/VehicleRegistration"));
const FleetKYB           = lazy(() => import("./pages/FleetKYB"));

// Status / tracking
const ApplicationStatus  = lazy(() => import("./pages/ApplicationStatus"));

// Portal group (~200 KB — device management, admin review)
const DeviceManagement   = lazy(() => import("./pages/DeviceManagement"));
const AdminReview        = lazy(() => import("./pages/AdminReview"));

// Analytics chunk (~450 KB — Recharts)
const AdminAnalytics     = lazy(() => import("./pages/AdminAnalytics"));

// Wallet chunk (~120 KB)
const WalletPage         = lazy(() => import("./pages/Wallet"));

// Map chunk (~180 KB — Google Maps bootstrap)
const TollMap            = lazy(() => import("./pages/TollMap"));

// NFC / USSD / Offline / Settings — small but rarely visited
const NfcProvisioning    = lazy(() => import("./pages/NfcProvisioning"));
const UssdSimulator      = lazy(() => import("./pages/UssdSimulator"));
const OfflineDashboard   = lazy(() => import("./pages/OfflineDashboard"));
const Settings           = lazy(() => import("./pages/Settings"));

// Admin User Management
const AdminUsers         = lazy(() => import("./pages/AdminUsers"));

// Admin Reconciliation
const AdminReconciliation = lazy(() => import("./pages/AdminReconciliation"));

// NFC Batch Provisioning — admin-only bulk tag provisioning
const NfcBatchProvision = lazy(() => import("./pages/NfcBatchProvision"));

// Wallet Confirm (post-payment redirect landing)
const WalletConfirm = lazy(() => import("./pages/WalletConfirm"));

// Gate Controller QR Scanner
const QrScanner = lazy(() => import("./pages/QrScanner"));

// Firmware Broadcast Dashboard
const FirmwareBroadcast = lazy(() => import("./pages/FirmwareBroadcast"));

// QR Scan History — admin audit log
const QrScanHistory = lazy(() => import("./pages/QrScanHistory"));

// USSD Sessions — admin session list with replay
const UssdSessions = lazy(() => import("./pages/UssdSessions"));

// Legal pages
const PrivacyPolicy = lazy(() => import("./pages/PrivacyPolicy"));
const TermsOfService = lazy(() => import("./pages/TermsOfService"));

// ── Shared route-level loading skeleton ──────────────────────────────────────
function RouteSkeleton() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-3">
        <div className="w-10 h-10 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    </div>
  );
}

// ── Protected route wrapper ───────────────────────────────────────────────────
function ProtectedRoute({
  component: Component,
  requiredRole,
}: {
  component: React.ComponentType;
  requiredRole?: string;
}) {
  const { isAuthenticated, isLoading, user } = useAuth();
  const [, navigate] = useLocation();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      navigate("/auth/login");
    }
    if (!isLoading && isAuthenticated && requiredRole && user?.role !== requiredRole) {
      navigate("/");
    }
  }, [isAuthenticated, isLoading, navigate, requiredRole, user]);

  if (isLoading) {
    return <RouteSkeleton />;
  }

  if (!isAuthenticated) return null;
  if (requiredRole && user?.role !== requiredRole) return null;
  return <Component />;
}

// ── SW update banner ──────────────────────────────────────────────────────────
function SWUpdateNotifier() {
  const { hasUpdate, updateSW } = useServiceWorker();
  useEffect(() => {
    if (hasUpdate) {
      toast.info("A new version of NigerianPass is available", {
        action: { label: "Update now", onClick: updateSW },
        duration: Infinity,
      });
    }
  }, [hasUpdate, updateSW]);
  return null;
}

function Router() {
  return (
    <>
      <Suspense fallback={<RouteSkeleton />}>
        <Switch>
          {/* ── Public routes (eager) ── */}
          <Route path="/" component={Landing} />
          <Route path="/auth/login" component={Login} />

          {/* ── Public routes (lazy) ── */}
          <Route path="/status" component={ApplicationStatus} />
          <Route path="/status/:applicationId" component={ApplicationStatus} />
          <Route path="/map" component={TollMap} />
          <Route path="/ussd" component={UssdSimulator} />
          <Route path="/offline" component={OfflineDashboard} />

          {/* ── Onboarding routes — require auth ── */}
          <Route path="/onboarding/driver">
            {() => <ProtectedRoute component={DriverOnboarding} />}
          </Route>
          <Route path="/onboarding/vehicle">
            {() => <ProtectedRoute component={VehicleRegistration} />}
          </Route>
          <Route path="/onboarding/fleet">
            {() => <ProtectedRoute component={FleetKYB} />}
          </Route>

          {/* ── Portal routes — require auth ── */}
          <Route path="/portal/devices">
            {() => <ProtectedRoute component={DeviceManagement} />}
          </Route>
          <Route path="/portal/admin">
            {() => <ProtectedRoute component={AdminReview} />}
          </Route>
          <Route path="/portal/analytics">
            {() => <ProtectedRoute component={AdminAnalytics} />}
          </Route>
          <Route path="/portal/users">
            {() => <ProtectedRoute component={AdminUsers} requiredRole="admin" />}
          </Route>
          <Route path="/portal/reconciliation">
            {() => <ProtectedRoute component={AdminReconciliation} requiredRole="admin" />}
          </Route>
          <Route path="/portal/nfc">
            {() => <ProtectedRoute component={NfcProvisioning} />}
          </Route>
          <Route path="/portal/nfc/batch">
            {() => <ProtectedRoute component={NfcBatchProvision} requiredRole="admin" />}
          </Route>
          <Route path="/wallet">
            {() => <ProtectedRoute component={WalletPage} />}
          </Route>
          <Route path="/wallet/confirm">
            {() => <ProtectedRoute component={WalletConfirm} />}
          </Route>
          <Route path="/settings">
            {() => <ProtectedRoute component={Settings} />}
          </Route>

          {/* ── Gate Controller QR Scanner ── */}
          <Route path="/portal/validate-qr">
            {() => <ProtectedRoute component={QrScanner} requiredRole="admin" />}
          </Route>

          {/* ── Firmware Broadcast Dashboard ── */}
          <Route path="/portal/firmware-broadcast">
            {() => <ProtectedRoute component={FirmwareBroadcast} requiredRole="admin" />}
          </Route>

          {/* ── QR Scan History ── */}
          <Route path="/portal/qr-scan-logs">
            {() => <ProtectedRoute component={QrScanHistory} requiredRole="admin" />}
          </Route>

          {/* ── USSD Sessions ── */}
          <Route path="/portal/ussd-sessions">
            {() => <ProtectedRoute component={UssdSessions} requiredRole="admin" />}
          </Route>

          {/* ── Legal pages (public) ── */}
          <Route path="/privacy" component={PrivacyPolicy} />
          <Route path="/terms" component={TermsOfService} />

          {/* ── Fallback ── */}
          <Route path="/404" component={NotFound} />
          <Route component={NotFound} />
        </Switch>
      </Suspense>

      {/* Global PWA overlays — outside Suspense so they never flicker */}
      <NetworkStatusBar />
      <DataSaverBanner />
      <MobileNav />
      <PwaInstallBanner />
      <SWUpdateNotifier />
    </>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <DataSaverProvider>
          <AuthProvider>
            <TooltipProvider>
              <Toaster richColors position="top-right" />
              <Router />
            </TooltipProvider>
          </AuthProvider>
        </DataSaverProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
