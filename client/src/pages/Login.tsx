/**
 * NigerianPass Login Page — SMS OTP only
 * Design: Premium Civic — Navy authority base, Sora + Nunito Sans
 * Split-panel layout: left = branded hero, right = OTP form
 *
 * Flow:
 *  1. Enter phone number → trpc.otp.send (Africa's Talking / Twilio SMS)
 *  2. Enter 6-digit code → trpc.otp.verify (server sets session cookie)
 *  3. Reload to pick up the session
 *
 * There is no password login or self-service registration — accounts are
 * created automatically on first OTP verification.
 */
import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Phone, CheckCircle2,
  Shield, Zap, Globe, MessageSquare, RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

// Only surface server-returned demo codes in development builds
const IS_DEV = import.meta.env.DEV;

// ── Schemas ───────────────────────────────────────────────────────────────────
const otpRequestSchema = z.object({
  phone: z.string().min(10, "Enter a valid phone number").max(15),
});

type OtpRequestForm = z.infer<typeof otpRequestSchema>;

// ── Hero features ─────────────────────────────────────────────────────────────
const FEATURES = [
  { icon: Shield, text: "Open-source KYC with NIN & BVN verification" },
  { icon: Zap, text: "Sub-150ms NFC toll payment at every plaza" },
  { icon: Globe, text: "USSD support for every GSM phone in Nigeria" },
];

// ── OTP digit input component ─────────────────────────────────────────────────
function OtpInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = value.padEnd(6, "").split("").slice(0, 6);

  const handleKey = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace") {
      if (digits[i]) {
        const next = [...digits];
        next[i] = "";
        onChange(next.join("").trim());
      } else if (i > 0) {
        inputRefs.current[i - 1]?.focus();
      }
    }
  };

  const handleChange = (i: number, e: React.ChangeEvent<HTMLInputElement>) => {
    const char = e.target.value.replace(/\D/g, "").slice(-1);
    const next = [...digits];
    next[i] = char;
    onChange(next.join("").trim());
    if (char && i < 5) inputRefs.current[i + 1]?.focus();
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    onChange(pasted);
    const lastIdx = Math.min(pasted.length, 5);
    inputRefs.current[lastIdx]?.focus();
    e.preventDefault();
  };

  return (
    <div className="flex gap-2 justify-center" onPaste={handlePaste}>
      {digits.map((d, i) => (
        <input
          key={i}
          ref={el => { inputRefs.current[i] = el; }}
          type="text"
          inputMode="numeric"
          maxLength={1}
          value={d}
          onChange={e => handleChange(i, e)}
          onKeyDown={e => handleKey(i, e)}
          className={cn(
            "w-11 h-13 text-center text-xl font-bold rounded-xl border-2 transition-all outline-none",
            "focus:border-primary focus:ring-2 focus:ring-primary/20",
            d ? "border-primary bg-primary/5 text-primary" : "border-border bg-background text-foreground"
          )}
          style={{ height: "3.25rem" }}
        />
      ))}
    </div>
  );
}

// ── Countdown timer ───────────────────────────────────────────────────────────
function Countdown({ seconds, onExpire }: { seconds: number; onExpire: () => void }) {
  const [remaining, setRemaining] = useState(seconds);
  useEffect(() => {
    setRemaining(seconds);
    const id = setInterval(() => setRemaining(r => {
      if (r <= 1) { clearInterval(id); onExpire(); return 0; }
      return r - 1;
    }), 1000);
    return () => clearInterval(id);
  }, [seconds, onExpire]);
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  return (
    <span className="font-mono text-sm text-muted-foreground">
      {m}:{s.toString().padStart(2, "0")}
    </span>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function Login() {
  // OTP state
  const [otpPhone, setOtpPhone] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [otpValue, setOtpValue] = useState("");
  const [otpExpiry, setOtpExpiry] = useState(120); // seconds
  const [otpExpired, setOtpExpired] = useState(false);
  const [otpSending, setOtpSending] = useState(false);
  const [otpVerifying, setOtpVerifying] = useState(false);

  const otpRequestForm = useForm<OtpRequestForm>({ resolver: zodResolver(otpRequestSchema) });

  // ── OTP flow (tRPC — Africa's Talking SMS) ────────────────────────────────
  const sendOtpMutation = trpc.otp.send.useMutation();
  const verifyOtpMutation = trpc.otp.verify.useMutation();

  const normalisePhone = (raw: string) =>
    raw.startsWith("+") ? raw : `+234${raw.replace(/^0/, "")}`;

  const onRequestOtp = async (data: OtpRequestForm) => {
    setOtpSending(true);
    try {
      const phone = normalisePhone(data.phone);
      const res = await sendOtpMutation.mutateAsync({ phone });
      setOtpPhone(phone);
      setOtpSent(true);
      setOtpExpiry(res.expiresInSeconds);
      setOtpExpired(false);
      setOtpValue("");
      if (IS_DEV && res.demoCode) {
        toast.success(`[dev] code: ${res.demoCode}. Sent to ${res.maskedPhone}.`);
      } else {
        toast.success(`OTP sent to ${res.maskedPhone}`);
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to send OTP");
    } finally {
      setOtpSending(false);
    }
  };

  const onVerifyOtp = async () => {
    if (otpValue.length !== 6) {
      toast.error("Enter the 6-digit code");
      return;
    }
    setOtpVerifying(true);
    try {
      await verifyOtpMutation.mutateAsync({ phone: otpPhone, code: otpValue });
      toast.success("OTP verified! Welcome to NigerianPass.");
      // Reload to pick up the session cookie set by the server
      window.location.href = "/";
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Invalid or expired OTP");
      setOtpValue("");
    } finally {
      setOtpVerifying(false);
    }
  };

  const onResendOtp = async () => {
    setOtpSending(true);
    try {
      const res = await sendOtpMutation.mutateAsync({ phone: otpPhone });
      setOtpExpiry(res.expiresInSeconds);
      setOtpExpired(false);
      setOtpValue("");
      if (IS_DEV && res.demoCode) {
        toast.success(`[dev] new code ${res.demoCode}`);
      } else {
        toast.success("New OTP sent");
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to resend OTP");
    } finally {
      setOtpSending(false);
    }
  };

  return (
    <div className="min-h-screen flex">
      {/* ── Left hero panel ─────────────────────────────────────────────────── */}
      <div
        className="hidden lg:flex lg:w-[52%] relative flex-col justify-between p-12 overflow-hidden"
        style={{
          background: "linear-gradient(135deg, #0f1f3d 0%, #1B2B4B 40%, #1e3a5f 70%, #0d2137 100%)",
        }}
      >
        <div
          className="absolute inset-0 opacity-[0.04]"
          style={{
            backgroundImage: `linear-gradient(rgba(255,255,255,0.5) 1px, transparent 1px),
              linear-gradient(90deg, rgba(255,255,255,0.5) 1px, transparent 1px)`,
            backgroundSize: "40px 40px",
          }}
        />
        <div className="absolute top-1/4 -left-20 w-80 h-80 rounded-full opacity-10"
          style={{ background: "radial-gradient(circle, #10b981, transparent)" }} />
        <div className="absolute bottom-1/3 right-10 w-60 h-60 rounded-full opacity-10"
          style={{ background: "radial-gradient(circle, #3b82f6, transparent)" }} />

        {/* Logo */}
        <div className="relative z-10 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-500 flex items-center justify-center shadow-lg">
            <Shield className="w-5 h-5 text-white" />
          </div>
          <span className="text-white font-bold text-xl tracking-tight" style={{ fontFamily: "Sora, sans-serif" }}>
            NigerianPass
          </span>
        </div>

        {/* Main copy */}
        <div className="relative z-10 space-y-8">
          <div>
            <h1 className="text-4xl xl:text-5xl font-bold text-white leading-tight mb-4"
              style={{ fontFamily: "Sora, sans-serif" }}>
              Nigeria's Digital<br />
              <span className="text-emerald-400">Toll & Transit</span><br />
              Pass Platform
            </h1>
            <p className="text-blue-200 text-lg leading-relaxed max-w-md">
              Register drivers, vehicles, and fleet companies. Manage toll booth devices in real time.
            </p>
          </div>

          <div className="space-y-4">
            {FEATURES.map(({ icon: Icon, text }) => (
              <div key={text} className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center flex-shrink-0">
                  <Icon className="w-4 h-4 text-emerald-400" />
                </div>
                <span className="text-blue-100 text-sm">{text}</span>
              </div>
            ))}
          </div>

          {/* SMS OTP highlight */}
          <div className="p-4 rounded-xl border border-emerald-500/20 bg-emerald-500/10">
            <div className="flex items-center gap-2 mb-1.5">
              <MessageSquare className="w-4 h-4 text-emerald-400" />
              <span className="text-emerald-300 text-sm font-semibold">No password? No problem.</span>
            </div>
            <p className="text-blue-200 text-xs leading-relaxed">
              Sign in with a one-time SMS code — works on any GSM phone, including feature phones. Powered by Africa's Talking.
            </p>
          </div>
        </div>

        {/* Stats */}
        <div className="relative z-10 grid grid-cols-3 gap-4">
          {[
            { value: "4,000+", label: "Vehicles/hr/lane" },
            { value: "150ms", label: "NFC latency" },
            { value: "36+", label: "States covered" },
          ].map(s => (
            <div key={s.label} className="text-center">
              <div className="text-2xl font-bold text-emerald-400" style={{ fontFamily: "Sora, sans-serif" }}>{s.value}</div>
              <div className="text-blue-300 text-xs mt-0.5">{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Right auth panel ─────────────────────────────────────────────────── */}
      <div className="flex-1 flex items-center justify-center p-6 bg-background">
        <div className="w-full max-w-md">
          {/* Mobile logo */}
          <div className="flex lg:hidden items-center gap-2 mb-8">
            <div className="w-8 h-8 rounded-lg bg-emerald-500 flex items-center justify-center">
              <Shield className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold text-lg" style={{ fontFamily: "Sora, sans-serif" }}>NigerianPass</span>
          </div>

          <AnimatePresence mode="wait">
            {/* ── SMS OTP login ──────────────────────────────────────────────── */}
            <motion.div
              key="otp"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
            >
              <div className="mb-6">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-8 h-8 rounded-lg bg-emerald-100 flex items-center justify-center">
                    <MessageSquare className="w-4 h-4 text-emerald-600" />
                  </div>
                  <h2 className="text-2xl font-bold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
                    Sign in with SMS OTP
                  </h2>
                </div>
                <p className="text-muted-foreground text-sm">
                  {otpSent
                    ? `Enter the 6-digit code sent to ${otpPhone}`
                    : "Enter your phone number to receive a one-time code via SMS. New here? Your account is created automatically on first sign-in."}
                </p>
              </div>

              <AnimatePresence mode="wait">
                {!otpSent ? (
                  /* Step 1 — request OTP */
                  <motion.div key="request" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                    <form onSubmit={otpRequestForm.handleSubmit(onRequestOtp)} className="space-y-4">
                      <div className="space-y-1.5">
                        <Label htmlFor="otp-phone">Phone Number</Label>
                        <div className="relative">
                          <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                          <Input id="otp-phone" placeholder="e.g. 08012345678" className="pl-9"
                            {...otpRequestForm.register("phone")} />
                        </div>
                        {otpRequestForm.formState.errors.phone && (
                          <p className="text-xs text-destructive">{otpRequestForm.formState.errors.phone.message}</p>
                        )}
                      </div>

                      <Button type="submit" className="w-full h-11 font-semibold" disabled={otpSending}>
                        {otpSending ? (
                          <span className="flex items-center gap-2">
                            <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                            Sending OTP...
                          </span>
                        ) : (
                          <span className="flex items-center gap-2">
                            <MessageSquare className="w-4 h-4" />
                            Send OTP via SMS
                          </span>
                        )}
                      </Button>
                    </form>

                    <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-xl">
                      <p className="text-xs text-amber-700">
                        A 6-digit code will be sent via SMS (Africa's Talking / Twilio). Standard SMS rates apply.
                      </p>
                    </div>
                  </motion.div>
                ) : (
                  /* Step 2 — enter OTP */
                  <motion.div key="verify" initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}>
                    <div className="space-y-5">
                      {/* OTP digit boxes */}
                      <div>
                        <Label className="block text-center mb-3">Enter 6-digit code</Label>
                        <OtpInput value={otpValue} onChange={setOtpValue} />
                      </div>

                      {/* Timer / resend */}
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">Code expires in</span>
                        {otpExpired ? (
                          <button
                            onClick={onResendOtp}
                            disabled={otpSending}
                            className="flex items-center gap-1.5 text-primary hover:underline font-medium"
                          >
                            <RefreshCw className={cn("w-3.5 h-3.5", otpSending && "animate-spin")} />
                            Resend OTP
                          </button>
                        ) : (
                          <Countdown seconds={otpExpiry} onExpire={() => setOtpExpired(true)} />
                        )}
                      </div>

                      <Button
                        className="w-full h-11 font-semibold"
                        onClick={onVerifyOtp}
                        disabled={otpVerifying || otpValue.length !== 6 || otpExpired}
                      >
                        {otpVerifying ? (
                          <span className="flex items-center gap-2">
                            <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                            Verifying...
                          </span>
                        ) : (
                          <span className="flex items-center gap-2">
                            <CheckCircle2 className="w-4 h-4" />
                            Verify & Sign In
                          </span>
                        )}
                      </Button>

                      <button
                        onClick={() => { setOtpSent(false); setOtpValue(""); otpRequestForm.reset(); }}
                        className="w-full text-xs text-muted-foreground hover:text-foreground transition-colors text-center"
                      >
                        ← Change phone number
                      </button>

                      {IS_DEV && (
                        <div className="p-3 bg-blue-50 border border-blue-200 rounded-xl">
                          <p className="text-xs text-blue-700 font-medium mb-0.5">Development build</p>
                          <p className="text-xs text-blue-600">When SMS is not configured, the server returns a demo code shown in the toast above.</p>
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
