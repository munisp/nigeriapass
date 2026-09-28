/**
 * Wallet Top-Up Confirmation Page — /wallet/confirm
 * ==================================================
 * Handles the post-payment redirect from Paystack and Flutterwave.
 *
 * Flow:
 *  1. Provider redirects to /wallet/confirm?reference=NP-PAYSTACK-...&provider=paystack
 *  2. This page polls trpc.wallet.getBalance every 3 seconds (up to 30s)
 *     until the balance increases (meaning reconciliation credited the wallet).
 *  3. On success → show confetti + credited amount, then redirect to /wallet.
 *  4. On timeout → show "pending" state with a link to /wallet and info about
 *     the nightly reconciliation job.
 *  5. On explicit failure (trxref=failed) → show error state.
 *
 * Design: Premium Civic — Navy authority base, Sora + Nunito Sans
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { useLocation, Link } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import {
  CheckCircle2, Clock, XCircle, RefreshCw, ArrowRight,
  Wallet, AlertTriangle, Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

// ── Constants ─────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 3_000;
const MAX_POLLS = 10; // 30 seconds total
const REDIRECT_DELAY_MS = 3_000;

// ── Types ─────────────────────────────────────────────────────────────────────

type ConfirmState = "polling" | "credited" | "pending" | "failed";

// ── Confetti burst (CSS-only, no extra package) ───────────────────────────────

function ConfettiBurst() {
  const colors = ["#10b981", "#3b82f6", "#f59e0b", "#8b5cf6", "#ef4444", "#06b6d4"];
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {Array.from({ length: 24 }).map((_, i) => {
        const color = colors[i % colors.length]!;
        const angle = (i / 24) * 360;
        const distance = 80 + Math.random() * 60;
        const size = 6 + Math.random() * 6;
        return (
          <motion.div
            key={i}
            className="absolute rounded-sm"
            style={{
              width: size,
              height: size,
              backgroundColor: color,
              left: "50%",
              top: "50%",
            }}
            initial={{ x: 0, y: 0, opacity: 1, rotate: 0 }}
            animate={{
              x: Math.cos((angle * Math.PI) / 180) * distance,
              y: Math.sin((angle * Math.PI) / 180) * distance,
              opacity: 0,
              rotate: 360 + Math.random() * 360,
            }}
            transition={{ duration: 0.9, ease: "easeOut", delay: i * 0.02 }}
          />
        );
      })}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function WalletConfirm() {
  const [, navigate] = useLocation();

  // Parse query params
  const params = new URLSearchParams(window.location.search);
  const reference = params.get("reference") ?? params.get("trxref") ?? params.get("transaction_id") ?? "";
  const provider = (params.get("provider") ?? "paystack").toLowerCase();
  const explicitStatus = params.get("status"); // "failed" from some providers

  const [state, setState] = useState<ConfirmState>(
    explicitStatus === "failed" || explicitStatus === "cancelled" ? "failed" : "polling"
  );
  const [pollCount, setPollCount] = useState(0);
  const [baselineBalance, setBaselineBalance] = useState<number | null>(null);
  const [creditedAmount, setCreditedAmount] = useState<number | null>(null);
  const [showConfetti, setShowConfetti] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const utils = trpc.useUtils();

  const balanceQuery = trpc.wallet.getBalance.useQuery(undefined, {
    enabled: state === "polling",
    refetchInterval: false, // we control polling manually
    staleTime: 0,
  });

  // Immediately verify and credit the wallet via the tRPC procedure
  // This short-circuits the polling loop for most successful payments
  const verifyTopup = trpc.wallet.verifyTopup.useQuery(
    {
      reference,
      provider: (provider === "paystack" || provider === "flutterwave") ? provider : "paystack",
    },
    {
      enabled: !!reference && state === "polling",
      retry: 2,
      staleTime: Infinity,
    }
  );

  // React to verifyTopup result
  useEffect(() => {
    if (!verifyTopup.data) return;
    const { status, amountKobo } = verifyTopup.data;
    if (status === "credited" || status === "already_credited") {
      setCreditedAmount(amountKobo);
      setState("credited");
      setShowConfetti(true);
      toast.success(`Wallet credited with ₦${(amountKobo / 100).toLocaleString("en-NG")}`);
      setTimeout(() => navigate("/wallet"), REDIRECT_DELAY_MS);
    } else if (status === "failed") {
      setState("failed");
    }
  }, [verifyTopup.data, navigate]);

  // Capture baseline balance on first load
  useEffect(() => {
    if (baselineBalance === null && balanceQuery.data) {
      setBaselineBalance(balanceQuery.data.balance_kobo);
    }
  }, [balanceQuery.data, baselineBalance]);

  const checkBalance = useCallback(async () => {
    if (state !== "polling") return;

    try {
      const fresh = await utils.wallet.getBalance.fetch(undefined);
      const newBalance = fresh.balance_kobo;

      if (baselineBalance !== null && newBalance > baselineBalance) {
        // Wallet was credited!
        const credited = newBalance - baselineBalance;
        setCreditedAmount(credited);
        setState("credited");
        setShowConfetti(true);
        toast.success(`Wallet credited with ₦${(credited / 100).toLocaleString("en-NG")}`);

        // Auto-redirect after 3 seconds
        setTimeout(() => navigate("/wallet"), REDIRECT_DELAY_MS);
        return;
      }

      setPollCount(prev => {
        const next = prev + 1;
        if (next >= MAX_POLLS) {
          setState("pending");
        }
        return next;
      });
    } catch {
      // Non-fatal — keep polling
    }
  }, [state, baselineBalance, utils, navigate]);

  // Start polling interval
  useEffect(() => {
    if (state !== "polling") {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }

    // Initial check after a short delay (give webhook time to arrive)
    const initialTimer = setTimeout(checkBalance, 1_500);

    pollRef.current = setInterval(checkBalance, POLL_INTERVAL_MS);

    return () => {
      clearTimeout(initialTimer);
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [state, checkBalance]);

  const progressPct = Math.min(100, (pollCount / MAX_POLLS) * 100);

  return (
    <div className="min-h-screen bg-[oklch(0.975_0.003_255)] flex items-center justify-center p-4">
      <div className="w-full max-w-md">

        {/* ── Card ── */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white rounded-2xl border border-border shadow-xl overflow-hidden"
        >
          {/* Header band */}
          <div className="bg-[#1e3a5f] px-6 py-4 flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center">
              <Wallet className="w-4 h-4 text-white" />
            </div>
            <div>
              <div className="text-white font-semibold text-sm" style={{ fontFamily: "Sora, sans-serif" }}>
                NigerianPass Wallet
              </div>
              <div className="text-white/60 text-xs capitalize">{provider} top-up</div>
            </div>
          </div>

          {/* Body */}
          <div className="p-8 flex flex-col items-center text-center gap-6 relative">
            <AnimatePresence mode="wait">

              {/* ── Polling state ── */}
              {state === "polling" && (
                <motion.div
                  key="polling"
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  className="flex flex-col items-center gap-4 w-full"
                >
                  <div className="relative w-20 h-20">
                    <div className="w-20 h-20 rounded-full border-4 border-[#1e3a5f]/10" />
                    <div className="absolute inset-0 w-20 h-20 rounded-full border-4 border-[#1e3a5f] border-t-transparent animate-spin" />
                    <div className="absolute inset-0 flex items-center justify-center">
                      <Zap className="w-7 h-7 text-[#1e3a5f]" />
                    </div>
                  </div>

                  <div>
                    <h2 className="text-xl font-bold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
                      Confirming Payment
                    </h2>
                    <p className="text-sm text-muted-foreground mt-1">
                      Waiting for your wallet to be credited…
                    </p>
                  </div>

                  {/* Progress bar */}
                  <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
                    <motion.div
                      className="h-full bg-[#1e3a5f] rounded-full"
                      animate={{ width: `${progressPct}%` }}
                      transition={{ duration: 0.4 }}
                    />
                  </div>

                  {reference && (
                    <div className="text-xs text-muted-foreground font-mono bg-muted/50 px-3 py-1.5 rounded-lg w-full truncate">
                      Ref: {reference}
                    </div>
                  )}
                </motion.div>
              )}

              {/* ── Credited state ── */}
              {state === "credited" && (
                <motion.div
                  key="credited"
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  className="flex flex-col items-center gap-4 w-full"
                >
                  {showConfetti && <ConfettiBurst />}

                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: "spring", stiffness: 300, damping: 20 }}
                    className="w-20 h-20 rounded-full bg-emerald-100 flex items-center justify-center"
                  >
                    <CheckCircle2 className="w-10 h-10 text-emerald-600" />
                  </motion.div>

                  <div>
                    <h2 className="text-xl font-bold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
                      Wallet Credited!
                    </h2>
                    {creditedAmount !== null && (
                      <p className="text-3xl font-bold text-emerald-600 mt-2" style={{ fontFamily: "Sora, sans-serif" }}>
                        +₦{(creditedAmount / 100).toLocaleString("en-NG")}
                      </p>
                    )}
                    <p className="text-sm text-muted-foreground mt-2">
                      Redirecting to your wallet in {REDIRECT_DELAY_MS / 1000} seconds…
                    </p>
                  </div>

                  <Link href="/wallet">
                    <Button className="bg-[#1e3a5f] hover:bg-[#162d4a] text-white gap-2">
                      Go to Wallet <ArrowRight className="w-4 h-4" />
                    </Button>
                  </Link>
                </motion.div>
              )}

              {/* ── Pending (timeout) state ── */}
              {state === "pending" && (
                <motion.div
                  key="pending"
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  className="flex flex-col items-center gap-4 w-full"
                >
                  <div className="w-20 h-20 rounded-full bg-amber-100 flex items-center justify-center">
                    <Clock className="w-10 h-10 text-amber-600" />
                  </div>

                  <div>
                    <h2 className="text-xl font-bold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
                      Payment Pending
                    </h2>
                    <p className="text-sm text-muted-foreground mt-2 max-w-xs">
                      Your payment was received but the wallet hasn't been credited yet.
                      This usually resolves within a few minutes.
                    </p>
                  </div>

                  {/* Info box */}
                  <div className="w-full bg-amber-50 border border-amber-200 rounded-xl p-4 text-left space-y-2">
                    <div className="flex items-center gap-2 text-amber-700 text-sm font-semibold">
                      <AlertTriangle className="w-4 h-4 shrink-0" />
                      What happens next?
                    </div>
                    <ul className="text-xs text-amber-700 space-y-1 list-disc list-inside">
                      <li>The reconciliation job runs automatically at <strong>02:00 WAT</strong> nightly</li>
                      <li>Your wallet will be credited once the transaction is confirmed</li>
                      <li>You'll receive a push notification when the credit is applied</li>
                    </ul>
                  </div>

                  {reference && (
                    <div className="text-xs text-muted-foreground font-mono bg-muted/50 px-3 py-1.5 rounded-lg w-full truncate">
                      Keep this ref: {reference}
                    </div>
                  )}

                  <div className="flex gap-3 w-full">
                    <Button
                      variant="outline"
                      className="flex-1 gap-2"
                      onClick={() => {
                        setPollCount(0);
                        setState("polling");
                      }}
                    >
                      <RefreshCw className="w-4 h-4" />
                      Check Again
                    </Button>
                    <Link href="/wallet" className="flex-1">
                      <Button className="w-full bg-[#1e3a5f] hover:bg-[#162d4a] text-white gap-2">
                        Go to Wallet <ArrowRight className="w-4 h-4" />
                      </Button>
                    </Link>
                  </div>
                </motion.div>
              )}

              {/* ── Failed state ── */}
              {state === "failed" && (
                <motion.div
                  key="failed"
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  className="flex flex-col items-center gap-4 w-full"
                >
                  <div className="w-20 h-20 rounded-full bg-red-100 flex items-center justify-center">
                    <XCircle className="w-10 h-10 text-red-600" />
                  </div>

                  <div>
                    <h2 className="text-xl font-bold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
                      Payment Cancelled
                    </h2>
                    <p className="text-sm text-muted-foreground mt-2">
                      The payment was not completed. No funds have been deducted.
                    </p>
                  </div>

                  <Link href="/wallet">
                    <Button className="bg-[#1e3a5f] hover:bg-[#162d4a] text-white gap-2">
                      Back to Wallet <ArrowRight className="w-4 h-4" />
                    </Button>
                  </Link>
                </motion.div>
              )}

            </AnimatePresence>
          </div>
        </motion.div>

        {/* Footer */}
        <p className="text-center text-xs text-muted-foreground mt-4">
          Secured by NigerianPass · Payments processed by {provider.charAt(0).toUpperCase() + provider.slice(1)}
        </p>
      </div>
    </div>
  );
}
