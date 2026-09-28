/**
 * NigerianPass Landing Page
 * Design: Premium Civic — Navy authority base, Sora + Nunito Sans
 * Auth-aware header with notification bell, wallet link, and login/logout.
 */
import { Link, useLocation } from "wouter";
import { motion } from "framer-motion";
import {
  ArrowRight, User, Car, Building2, Monitor, ShieldCheck,
  CheckCircle, Zap, Globe, Lock, Wallet, LogOut, LogIn, Map,
  Phone, BarChart2, Settings, RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/_core/hooks/useAuth";
import NotificationBell from "@/components/NotificationBell";
import { toast } from "sonner";

const HERO_IMG = "https://d2xsxph8kpxj0f.cloudfront.net/114501028/9uoCntQGmxrFDSX5CAeixb/np-hero-onboarding_e10430f7.png";
const KYC_BANNER = "https://d2xsxph8kpxj0f.cloudfront.net/114501028/9uoCntQGmxrFDSX5CAeixb/np-kyc-banner_efaeaa39.png";
const DEVICE_IMG = "https://d2xsxph8kpxj0f.cloudfront.net/114501028/9uoCntQGmxrFDSX5CAeixb/np-device-dashboard_61563c63.png";
const FLEET_IMG = "https://d2xsxph8kpxj0f.cloudfront.net/114501028/9uoCntQGmxrFDSX5CAeixb/np-fleet-kyb_089c4c1a.png";

const PORTALS = [
  {
    icon: User,
    title: "Driver KYC",
    description: "Register as a driver with NIN/BVN verification, biometric liveness check, and document upload.",
    href: "/onboarding/driver",
    accent: "from-emerald-500 to-emerald-600",
    badge: "For Individuals",
    badgeColor: "bg-emerald-100 text-emerald-700",
  },
  {
    icon: Car,
    title: "Vehicle Registration",
    description: "Register your vehicle with FRSC verification, insurance validation, and toll class assignment.",
    href: "/onboarding/vehicle",
    accent: "from-blue-500 to-blue-600",
    badge: "For Vehicle Owners",
    badgeColor: "bg-blue-100 text-blue-700",
  },
  {
    icon: Building2,
    title: "Fleet KYB",
    description: "Register your transport company with CAC/TIN verification and fleet account setup.",
    href: "/onboarding/fleet",
    accent: "from-amber-500 to-amber-600",
    badge: "For Businesses",
    badgeColor: "bg-amber-100 text-amber-700",
  },
  {
    icon: Monitor,
    title: "Device Management",
    description: "Manage toll booth hardware — cameras, barriers, RFID readers, and edge compute units.",
    href: "/portal/devices",
    accent: "from-purple-500 to-purple-600",
    badge: "For Operators",
    badgeColor: "bg-purple-100 text-purple-700",
  },
  {
    icon: ShieldCheck,
    title: "Admin Review",
    description: "Review and approve KYC/KYB applications with document verification and audit trail.",
    href: "/portal/admin",
    accent: "from-red-500 to-red-600",
    badge: "For Admins",
    badgeColor: "bg-red-100 text-red-700",
  },
  {
    icon: Wallet,
    title: "My Wallet",
    description: "View your toll wallet balance, top up via Paystack or Flutterwave, and review transaction history.",
    href: "/wallet",
    accent: "from-teal-500 to-teal-600",
    badge: "For All Users",
    badgeColor: "bg-teal-100 text-teal-700",
  },
  {
    icon: Map,
    title: "Toll Plaza Map",
    description: "Live Google Maps view of all 12+ NigerianPass toll plazas — status, throughput, and revenue.",
    href: "/map",
    accent: "from-sky-500 to-sky-600",
    badge: "Public",
    badgeColor: "bg-sky-100 text-sky-700",
  },
  {
    icon: Phone,
    title: "USSD Simulator",
    description: "Preview the *346# feature-phone USSD flow — balance check, top-up, mini statement, and vehicle registration.",
    href: "/ussd",
    accent: "from-lime-500 to-lime-600",
    badge: "Feature Phones",
    badgeColor: "bg-lime-100 text-lime-700",
  },
  {
    icon: BarChart2,
    title: "Analytics",
    description: "KYC/KYB approval rates, rejection reasons, per-state volume, processing time, and KYC score distribution.",
    href: "/portal/analytics",
    accent: "from-violet-500 to-violet-600",
    badge: "For Admins",
    badgeColor: "bg-violet-100 text-violet-700",
  },
  {
    icon: Settings,
    title: "Settings",
    description: "Data Saver mode, background sync, push notifications, and offline storage preferences.",
    href: "/settings",
    accent: "from-gray-500 to-gray-600",
    badge: "For All Users",
    badgeColor: "bg-gray-100 text-gray-700",
  },
  {
    icon: RefreshCw,
    title: "Reconciliation",
    description: "Match pending top-up transactions to wallet accounts. Run manually or let the nightly 02:00 WAT scheduler handle it.",
    href: "/portal/reconciliation",
    accent: "from-orange-500 to-orange-600",
    badge: "For Admins",
    badgeColor: "bg-orange-100 text-orange-700",
  },
];

const FEATURES = [
  { icon: Zap, title: "150ms Toll Processing", desc: "Sub-200ms end-to-end NFC tap to barrier open" },
  { icon: Lock, title: "AES-128 CMAC Security", desc: "Cryptographic NFC tag verification, replay-proof" },
  { icon: Globe, title: "Works on Any Phone", desc: "NFC smartphones, feature phones via USSD/SMS" },
  { icon: CheckCircle, title: "Open-Source KYC", desc: "PaddleOCR + VLM + MediaPipe liveness detection" },
];

export default function Landing() {
  const { isAuthenticated, user, logout } = useAuth();
  const [, navigate] = useLocation();

  const handleLogout = async () => {
    await logout();
    toast.success("Signed out successfully");
    navigate("/");
  };

  return (
    <div className="min-h-screen bg-[oklch(0.975_0.003_255)]">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="fixed top-0 left-0 right-0 z-50 bg-white/90 backdrop-blur-md border-b border-border">
        <div className="container flex items-center justify-between h-16">
          {/* Logo */}
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-[oklch(0.28_0.07_255)] flex items-center justify-center">
              <CheckCircle className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>NigerianPass</span>
          </div>

          {/* Nav */}
          <nav className="hidden md:flex items-center gap-4">
            <a href="#portals" className="text-sm text-muted-foreground hover:text-foreground transition-colors">Portals</a>
            <a href="#features" className="text-sm text-muted-foreground hover:text-foreground transition-colors">Features</a>

            {isAuthenticated ? (
              <>
            <Link href="/wallet">
              <button className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
                <Wallet className="w-3.5 h-3.5" />
                Wallet
              </button>
            </Link>
            <Link href="/map">
              <button className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
                <Map className="w-3.5 h-3.5" />
                Toll Map
              </button>
            </Link>
                <NotificationBell />
                <div className="flex items-center gap-2 pl-2 border-l border-border">
                  <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center">
                    <User className="w-3.5 h-3.5 text-primary" />
                  </div>
                  <span className="text-xs text-muted-foreground capitalize">{user?.role?.replace("_", " ")}</span>
                  <button
                    onClick={handleLogout}
                    className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground"
                    title="Sign out"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                  </button>
                </div>
              </>
            ) : (
              <Link href="/auth/login">
                <Button size="sm" variant="outline" className="gap-1.5">
                  <LogIn className="w-3.5 h-3.5" />
                  Sign In
                </Button>
              </Link>
            )}
          </nav>

          {/* Mobile nav */}
          <div className="flex md:hidden items-center gap-2">
            {isAuthenticated && <NotificationBell />}
            <Link href={isAuthenticated ? "/wallet" : "/auth/login"}>
              <Button size="sm" variant="outline">
                {isAuthenticated ? <Wallet className="w-3.5 h-3.5" /> : <LogIn className="w-3.5 h-3.5" />}
              </Button>
            </Link>
          </div>
        </div>
      </header>

      {/* ── Hero ───────────────────────────────────────────────────────────── */}
      <section className="relative pt-16 overflow-hidden">
        <div
          className="absolute inset-0 bg-cover bg-center"
          style={{ backgroundImage: `url(${HERO_IMG})` }}
        />
        <div className="absolute inset-0 bg-gradient-to-b from-[oklch(0.18_0.07_255)]/80 via-[oklch(0.18_0.07_255)]/60 to-[oklch(0.975_0.003_255)]" />

        <div className="relative container py-24 md:py-36">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, ease: "easeOut" }}
            className="max-w-3xl"
          >
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 text-xs font-medium mb-6">
              <Zap className="w-3 h-3" />
              Nigeria's Digital Toll & Transit Pass Platform
            </div>
            <h1 className="text-4xl md:text-6xl font-extrabold text-white mb-6 leading-tight" style={{ fontFamily: "Sora, sans-serif" }}>
              Seamless Onboarding for
              <span className="text-emerald-400"> Every Road User</span>
            </h1>
            <p className="text-lg text-white/70 mb-8 max-w-xl leading-relaxed">
              Register drivers, vehicles, and fleet companies. Manage toll booth devices in real time. All with open-source KYC, cryptographic NFC security, and USSD support for every phone.
            </p>
            <div className="flex flex-wrap gap-3">
              {isAuthenticated ? (
                <>
                  <Link href="/onboarding/driver">
                    <Button size="lg" className="bg-emerald-500 hover:bg-emerald-600 text-white shadow-lg shadow-emerald-500/30 gap-2">
                      Start Driver KYC <ArrowRight className="w-4 h-4" />
                    </Button>
                  </Link>
                  <Link href="/wallet">
                    <Button size="lg" variant="outline" className="border-white/30 text-white hover:bg-white/10 bg-transparent gap-2">
                      <Wallet className="w-4 h-4" />
                      My Wallet
                    </Button>
                  </Link>
                </>
              ) : (
                <>
                  <Link href="/auth/login">
                    <Button size="lg" className="bg-emerald-500 hover:bg-emerald-600 text-white shadow-lg shadow-emerald-500/30 gap-2">
                      Get Started <ArrowRight className="w-4 h-4" />
                    </Button>
                  </Link>
                  <Link href="/portal/admin">
                    <Button size="lg" variant="outline" className="border-white/30 text-white hover:bg-white/10 bg-transparent">
                      Admin Portal
                    </Button>
                  </Link>
                </>
              )}
            </div>
          </motion.div>
        </div>
      </section>

      {/* ── Features strip ─────────────────────────────────────────────────── */}
      <section id="features" className="bg-[oklch(0.28_0.07_255)] py-10">
        <div className="container">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            {FEATURES.map((f, i) => (
              <motion.div
                key={f.title}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.1 }}
                viewport={{ once: true }}
                className="flex items-start gap-3"
              >
                <div className="w-9 h-9 rounded-lg bg-white/10 flex items-center justify-center shrink-0">
                  <f.icon className="w-4 h-4 text-emerald-400" />
                </div>
                <div>
                  <div className="text-sm font-semibold text-white" style={{ fontFamily: "Sora, sans-serif" }}>{f.title}</div>
                  <div className="text-xs text-white/50 mt-0.5">{f.desc}</div>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Portals ────────────────────────────────────────────────────────── */}
      <section id="portals" className="py-20">
        <div className="container">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="mb-12"
          >
            <h2 className="text-3xl font-bold text-foreground mb-3" style={{ fontFamily: "Sora, sans-serif" }}>
              Choose Your Portal
            </h2>
            <p className="text-muted-foreground max-w-xl">
              Each portal is purpose-built for a specific stakeholder — from individual drivers to fleet operators and government administrators.
            </p>
          </motion.div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {PORTALS.map((portal, i) => (
              <motion.div
                key={portal.href}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.08 }}
                viewport={{ once: true }}
              >
                <Link href={portal.href}>
                  <div className="group bg-white rounded-xl border border-border p-6 hover:shadow-lg hover:shadow-black/8 transition-all duration-300 hover:-translate-y-1 cursor-pointer h-full flex flex-col">
                    <div className="flex items-start justify-between mb-4">
                      <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${portal.accent} flex items-center justify-center shadow-lg`}>
                        <portal.icon className="w-6 h-6 text-white" />
                      </div>
                      <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${portal.badgeColor}`}>
                        {portal.badge}
                      </span>
                    </div>
                    <h3 className="text-lg font-bold text-foreground mb-2" style={{ fontFamily: "Sora, sans-serif" }}>
                      {portal.title}
                    </h3>
                    <p className="text-sm text-muted-foreground flex-1 leading-relaxed">
                      {portal.description}
                    </p>
                    <div className="mt-4 flex items-center gap-1.5 text-sm font-medium text-primary group-hover:gap-2.5 transition-all">
                      Get Started <ArrowRight className="w-4 h-4" />
                    </div>
                  </div>
                </Link>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ── KYC showcase ───────────────────────────────────────────────────── */}
      <section className="py-20 bg-white">
        <div className="container">
          <div className="grid md:grid-cols-2 gap-12 items-center">
            <motion.div
              initial={{ opacity: 0, x: -30 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
            >
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-100 text-emerald-700 text-xs font-medium mb-4">
                <CheckCircle className="w-3 h-3" />
                Open-Source KYC Pipeline
              </div>
              <h2 className="text-3xl font-bold text-foreground mb-4" style={{ fontFamily: "Sora, sans-serif" }}>
                AI-Powered Identity Verification
              </h2>
              <p className="text-muted-foreground leading-relaxed mb-6">
                Our KYC pipeline uses PaddleOCR for document text extraction, Qwen2-VL-2B for visual understanding, MiniFASNet for passive liveness detection, and MediaPipe Face Mesh for active challenge-response verification.
              </p>
              <div className="space-y-3">
                {[
                  "NIN & BVN verification via NIMC/NIBSS",
                  "Passive liveness with anti-spoofing (MiniFASNet)",
                  "Active challenges: blink, turn, smile, nod",
                  "ArcFace face matching against document photo",
                ].map(item => (
                  <div key={item} className="flex items-center gap-2.5">
                    <CheckCircle className="w-4 h-4 text-emerald-500 shrink-0" />
                    <span className="text-sm text-foreground">{item}</span>
                  </div>
                ))}
              </div>
            </motion.div>
            <motion.div
              initial={{ opacity: 0, x: 30 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              className="rounded-2xl overflow-hidden shadow-xl"
            >
              <img src={KYC_BANNER} alt="KYC verification pipeline" className="w-full h-64 object-cover" />
            </motion.div>
          </div>
        </div>
      </section>

      {/* ── Device & Fleet showcase ─────────────────────────────────────────── */}
      <section className="py-20 bg-[oklch(0.975_0.003_255)]">
        <div className="container">
          <div className="grid md:grid-cols-2 gap-8">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              className="rounded-2xl overflow-hidden shadow-lg"
            >
              <img src={DEVICE_IMG} alt="Device management dashboard" className="w-full h-48 object-cover" />
              <div className="p-5 bg-white">
                <h3 className="font-bold text-foreground mb-1" style={{ fontFamily: "Sora, sans-serif" }}>
                  Real-Time Device Dashboard
                </h3>
                <p className="text-sm text-muted-foreground">
                  Monitor toll booth hardware health, firmware versions, and live transaction metrics via WebSocket heartbeat.
                </p>
              </div>
            </motion.div>
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              viewport={{ once: true }}
              className="rounded-2xl overflow-hidden shadow-lg"
            >
              <img src={FLEET_IMG} alt="Fleet KYB portal" className="w-full h-48 object-cover" />
              <div className="p-5 bg-white">
                <h3 className="font-bold text-foreground mb-1" style={{ fontFamily: "Sora, sans-serif" }}>
                  Fleet KYB Portal
                </h3>
                <p className="text-sm text-muted-foreground">
                  CAC/TIN verification, fleet wallet provisioning, and multi-vehicle management for transport companies.
                </p>
              </div>
            </motion.div>
          </div>
        </div>
      </section>

      {/* ── Footer ─────────────────────────────────────────────────────────── */}
      <footer className="bg-[oklch(0.28_0.07_255)] py-8">
        <div className="container flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 rounded-lg bg-emerald-500 flex items-center justify-center">
              <CheckCircle className="w-4 h-4 text-white" />
            </div>
            <span className="text-white font-semibold text-sm" style={{ fontFamily: "Sora, sans-serif" }}>NigerianPass</span>
          </div>
          <p className="text-white/40 text-xs">
            © 2025 NigerianPass. Federal Republic of Nigeria Digital Infrastructure.
          </p>
          <div className="flex items-center gap-4">
            <a href="/privacy" className="text-white/40 text-xs hover:text-white/70 transition-colors">
              Privacy Policy
            </a>
            <a href="/terms" className="text-white/40 text-xs hover:text-white/70 transition-colors">
              Terms of Service
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
