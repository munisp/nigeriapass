/**
 * NigerianPass Login & Register Page
 * Design: Premium Civic — Navy authority base, Sora + Nunito Sans
 * Split-panel layout: left = branded hero, right = auth form
 *
 * Three tabs:
 *  1. Sign In   — phone + password (JWT)
 *  2. OTP Login — phone + 6-digit SMS OTP (Africa's Talking / Twilio)
 *  3. Register  — phone + email + password + role selector
 */
import { useState, useRef, useEffect } from "react";
import { useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Eye, EyeOff, Phone, Lock, Mail, ArrowRight, CheckCircle2,
  Shield, Zap, Globe, MessageSquare, RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import { authApi, tokenStore } from "@/lib/api";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import PushNotificationPrompt from "@/components/PushNotificationPrompt";

// ── Schemas ───────────────────────────────────────────────────────────────────
const loginSchema = z.object({
  phone: z.string().min(10, "Enter a valid phone number").max(15),
  password: z.string().min(6, "Password must be at least 6 characters"),
});

const otpRequestSchema = z.object({
  phone: z.string().min(10, "Enter a valid phone number").max(15),
});

const registerSchema = z.object({
  phone: z.string().min(10, "Enter a valid phone number").max(15),
  email: z.string().email("Enter a valid email address"),
  password: z.string()
    .min(8, "Password must be at least 8 characters")
    .regex(/[A-Z]/, "Must contain at least one uppercase letter")
    .regex(/[0-9]/, "Must contain at least one number"),
  confirmPassword: z.string(),
  role: z.enum(["driver", "fleet_operator", "operator"]),
}).refine(d => d.password === d.confirmPassword, {
  message: "Passwords do not match",
  path: ["confirmPassword"],
});

type LoginForm = z.infer<typeof loginSchema>;
type OtpRequestForm = z.infer<typeof otpRequestSchema>;
type RegisterForm = z.infer<typeof registerSchema>;
type Tab = "login" | "otp" | "register";

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
  const [tab, setTab] = useState<Tab>("login");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const { login, register, isAuthenticated } = useAuth();
  const [, navigate] = useLocation();
  const [showPushPrompt, setShowPushPrompt] = useState(false);

  // OTP state
  const [otpPhone, setOtpPhone] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [otpValue, setOtpValue] = useState("");
  const [otpExpiry, setOtpExpiry] = useState(120); // seconds
  const [otpExpired, setOtpExpired] = useState(false);
  const [otpSending, setOtpSending] = useState(false);
  const [otpVerifying, setOtpVerifying] = useState(false);

  // ── Login form ──────────────────────────────────────────────────────────────
  const loginForm = useForm<LoginForm>({ resolver: zodResolver(loginSchema) });
  const otpRequestForm = useForm<OtpRequestForm>({ resolver: zodResolver(otpRequestSchema) });
  const registerForm = useForm<RegisterForm>({
    resolver: zodResolver(registerSchema),
    defaultValues: { role: "driver" },
  });

  const onLogin = async (data: LoginForm) => {
    try {
      await login(data.phone, data.password);
      toast.success("Welcome back!");
      setShowPushPrompt(true);
      setTimeout(() => navigate("/"), 2000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Login failed";
      toast.error(msg.includes("401") ? "Invalid phone or password" : msg);
    }
  };

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
      if (res.demoCode) {
        toast.success(`Demo — code: ${res.demoCode}. Sent to ${res.maskedPhone}.`);
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
      if (res.demoCode) {
        toast.success(`Demo: new code ${res.demoCode}`);
      } else {
        toast.success("New OTP sent");
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to resend OTP");
    } finally {
      setOtpSending(false);
    }
  };

  // ── Register form ───────────────────────────────────────────────────────────
  const onRegister = async (data: RegisterForm) => {
    try {
      await register(data.phone, data.email, data.password);
      toast.success("Account created! Welcome to NigerianPass.");
      navigate("/");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Registration failed";
      toast.error(msg.includes("409") ? "An account with this phone already exists" : msg);
    }
  };

  const TABS: { id: Tab; label: string }[] = [
    { id: "login", label: "Password" },
    { id: "otp", label: "SMS OTP" },
    { id: "register", label: "Register" },
  ];

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

          {/* Tab selector */}
          <div className="flex bg-muted rounded-xl p-1 mb-8">
            {TABS.map(t => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  "flex-1 py-2 text-sm font-medium rounded-lg transition-all duration-200",
                  tab === t.id
                    ? "bg-white shadow-sm text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          <AnimatePresence mode="wait">
            {/* ── Password login ─────────────────────────────────────────────── */}
            {tab === "login" && (
              <motion.div
                key="login"
                initial={{ opacity: 0, x: -16 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 16 }}
                transition={{ duration: 0.2 }}
              >
                <div className="mb-6">
                  <h2 className="text-2xl font-bold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
                    Welcome back
                  </h2>
                  <p className="text-muted-foreground text-sm mt-1">Sign in with your phone and password</p>
                </div>

                <form onSubmit={loginForm.handleSubmit(onLogin)} className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="login-phone">Phone Number</Label>
                    <div className="relative">
                      <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input id="login-phone" placeholder="e.g. 08012345678" className="pl-9"
                        {...loginForm.register("phone")} />
                    </div>
                    {loginForm.formState.errors.phone && (
                      <p className="text-xs text-destructive">{loginForm.formState.errors.phone.message}</p>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="login-password">Password</Label>
                      <button type="button" className="text-xs text-primary hover:underline"
                        onClick={() => toast.info("Password reset via SMS — use the OTP tab")}>
                        Forgot password?
                      </button>
                    </div>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input id="login-password" type={showPassword ? "text" : "password"}
                        placeholder="Your password" className="pl-9 pr-9"
                        {...loginForm.register("password")} />
                      <button type="button" onClick={() => setShowPassword(p => !p)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                    {loginForm.formState.errors.password && (
                      <p className="text-xs text-destructive">{loginForm.formState.errors.password.message}</p>
                    )}
                  </div>

                  <Button type="submit" className="w-full h-11 font-semibold"
                    disabled={loginForm.formState.isSubmitting}>
                    {loginForm.formState.isSubmitting ? (
                      <span className="flex items-center gap-2">
                        <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        Signing in...
                      </span>
                    ) : (
                      <span className="flex items-center gap-2">Sign In <ArrowRight className="w-4 h-4" /></span>
                    )}
                  </Button>
                </form>

                <div className="mt-5 p-3 bg-blue-50 border border-blue-200 rounded-xl">
                  <p className="text-xs text-blue-700 font-medium mb-1">Demo credentials</p>
                  <p className="text-xs text-blue-600">Phone: <code className="bg-blue-100 px-1 rounded">08012345678</code></p>
                  <p className="text-xs text-blue-600">Password: <code className="bg-blue-100 px-1 rounded">Demo@1234</code></p>
                </div>

                <div className="mt-4 text-center">
                  <button onClick={() => setTab("otp")}
                    className="text-xs text-muted-foreground hover:text-primary transition-colors flex items-center gap-1 mx-auto">
                    <MessageSquare className="w-3 h-3" />
                    Sign in with SMS OTP instead
                  </button>
                </div>
              </motion.div>
            )}

            {/* ── SMS OTP login ──────────────────────────────────────────────── */}
            {tab === "otp" && (
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
                      SMS OTP Login
                    </h2>
                  </div>
                  <p className="text-muted-foreground text-sm">
                    {otpSent
                      ? `Enter the 6-digit code sent to ${otpPhone}`
                      : "Enter your phone number to receive a one-time code via SMS"}
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
                              {otpSending ? (
                                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <RefreshCw className="w-3.5 h-3.5" />
                              )}
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

                        <div className="p-3 bg-blue-50 border border-blue-200 rounded-xl">
                          <p className="text-xs text-blue-700 font-medium mb-0.5">Demo mode</p>
                          <p className="text-xs text-blue-600">Use code <code className="bg-blue-100 px-1 rounded">123456</code> to sign in</p>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            )}

            {/* ── Register ───────────────────────────────────────────────────── */}
            {tab === "register" && (
              <motion.div
                key="register"
                initial={{ opacity: 0, x: 16 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -16 }}
                transition={{ duration: 0.2 }}
              >
                <div className="mb-6">
                  <h2 className="text-2xl font-bold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
                    Create account
                  </h2>
                  <p className="text-muted-foreground text-sm mt-1">Join NigerianPass — it takes under 2 minutes</p>
                </div>

                <form onSubmit={registerForm.handleSubmit(onRegister)} className="space-y-4">
                  {/* Role selector */}
                  <div className="space-y-1.5">
                    <Label>I am a</Label>
                    <div className="grid grid-cols-3 gap-2">
                      {([
                        { value: "driver", label: "Driver" },
                        { value: "fleet_operator", label: "Fleet Operator" },
                        { value: "operator", label: "Toll Operator" },
                      ] as const).map(r => (
                        <button key={r.value} type="button"
                          onClick={() => registerForm.setValue("role", r.value)}
                          className={cn(
                            "py-2 px-2 text-xs font-medium rounded-lg border transition-all",
                            registerForm.watch("role") === r.value
                              ? "border-primary bg-primary/5 text-primary"
                              : "border-border text-muted-foreground hover:border-primary/50"
                          )}>
                          {r.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="reg-phone">Phone Number</Label>
                    <div className="relative">
                      <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input id="reg-phone" placeholder="e.g. 08012345678" className="pl-9"
                        {...registerForm.register("phone")} />
                    </div>
                    {registerForm.formState.errors.phone && (
                      <p className="text-xs text-destructive">{registerForm.formState.errors.phone.message}</p>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="reg-email">Email Address</Label>
                    <div className="relative">
                      <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input id="reg-email" type="email" placeholder="you@example.com" className="pl-9"
                        {...registerForm.register("email")} />
                    </div>
                    {registerForm.formState.errors.email && (
                      <p className="text-xs text-destructive">{registerForm.formState.errors.email.message}</p>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="reg-password">Password</Label>
                      <div className="relative">
                        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                        <Input id="reg-password" type={showPassword ? "text" : "password"}
                          placeholder="Min 8 chars" className="pl-9 pr-9"
                          {...registerForm.register("password")} />
                        <button type="button" onClick={() => setShowPassword(p => !p)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                          {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                      {registerForm.formState.errors.password && (
                        <p className="text-xs text-destructive">{registerForm.formState.errors.password.message}</p>
                      )}
                    </div>

                    <div className="space-y-1.5">
                      <Label htmlFor="reg-confirm">Confirm</Label>
                      <div className="relative">
                        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                        <Input id="reg-confirm" type={showConfirm ? "text" : "password"}
                          placeholder="Repeat" className="pl-9 pr-9"
                          {...registerForm.register("confirmPassword")} />
                        <button type="button" onClick={() => setShowConfirm(p => !p)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                          {showConfirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                      {registerForm.formState.errors.confirmPassword && (
                        <p className="text-xs text-destructive">{registerForm.formState.errors.confirmPassword.message}</p>
                      )}
                    </div>
                  </div>

                  {registerForm.watch("password") && (
                    <PasswordStrength password={registerForm.watch("password")} />
                  )}

                  <Button type="submit" className="w-full h-11 font-semibold"
                    disabled={registerForm.formState.isSubmitting}>
                    {registerForm.formState.isSubmitting ? (
                      <span className="flex items-center gap-2">
                        <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        Creating account...
                      </span>
                    ) : (
                      <span className="flex items-center gap-2">Create Account <ArrowRight className="w-4 h-4" /></span>
                    )}
                  </Button>

                  <p className="text-xs text-muted-foreground text-center">
                    By creating an account you agree to our{" "}
                    <a href="/terms" className="text-primary hover:underline">Terms of Service</a>
                    {" "}and{" "}
                    <a href="/privacy" className="text-primary hover:underline">Privacy Policy</a>
                  </p>
                </form>
              </motion.div>
            )}
          </AnimatePresence>
        {/* Push notification opt-in — shown after login */}
        {showPushPrompt && (
          <div className="mt-4">
            <PushNotificationPrompt onDismiss={() => navigate("/")} />
          </div>
        )}
        </div>
      </div>
    </div>
  );
}

// ── Password strength meter ───────────────────────────────────────────────────
function PasswordStrength({ password }: { password: string }) {
  const checks = [
    { label: "8+ characters", pass: password.length >= 8 },
    { label: "Uppercase", pass: /[A-Z]/.test(password) },
    { label: "Number", pass: /[0-9]/.test(password) },
    { label: "Special char", pass: /[^A-Za-z0-9]/.test(password) },
  ];
  const score = checks.filter(c => c.pass).length;
  const colors = ["bg-red-400", "bg-orange-400", "bg-yellow-400", "bg-emerald-400", "bg-emerald-500"];
  const labels = ["", "Weak", "Fair", "Good", "Strong"];

  return (
    <div className="space-y-2">
      <div className="flex gap-1">
        {[0, 1, 2, 3].map(i => (
          <div key={i} className={cn("h-1 flex-1 rounded-full transition-all duration-300",
            i < score ? colors[score] : "bg-muted")} />
        ))}
      </div>
      <div className="flex items-center justify-between">
        <div className="flex gap-3">
          {checks.map(c => (
            <span key={c.label} className={cn("text-[10px] flex items-center gap-0.5",
              c.pass ? "text-emerald-600" : "text-muted-foreground")}>
              {c.pass && <CheckCircle2 className="w-2.5 h-2.5" />}
              {c.label}
            </span>
          ))}
        </div>
        <span className={cn("text-xs font-medium", score >= 3 ? "text-emerald-600" : "text-muted-foreground")}>
          {labels[score]}
        </span>
      </div>
    </div>
  );
}
