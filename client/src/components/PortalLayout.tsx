import { useState } from "react";
import { Link, useLocation } from "wouter";
import {
  User, Car, Building2, Monitor, ShieldCheck,
  ChevronRight, Menu, X, LogOut, Bell, CheckCircle2,
  FileText, Settings, RefreshCw, BarChart3, Users, Wifi, Package, ScanLine, Radio, History, Phone
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import { getLoginUrl } from "@/const";

const NAV_ITEMS = [
  {
    group: "Onboarding",
    items: [
      { label: "Driver KYC", icon: User, href: "/onboarding/driver", accent: "emerald", description: "Identity verification" },
      { label: "Vehicle Registration", icon: Car, href: "/onboarding/vehicle", accent: "blue", description: "Register your vehicle" },
      { label: "Fleet KYB", icon: Building2, href: "/onboarding/fleet", accent: "amber", description: "Business verification" },
    ]
  },
  {
    group: "Operations",
    items: [
      { label: "Device Management", icon: Monitor, href: "/portal/devices", accent: "purple", description: "Toll booth devices" },
      { label: "Admin Review", icon: ShieldCheck, href: "/portal/admin", accent: "crimson", description: "KYC/KYB review queue" },
      { label: "Reconciliation", icon: RefreshCw, href: "/portal/reconciliation", accent: "teal", description: "Payment matching & credits" },
      { label: "Analytics", icon: BarChart3, href: "/portal/analytics", accent: "indigo", description: "Platform metrics & insights" },
      { label: "User Management", icon: Users, href: "/portal/users", accent: "rose", description: "Admin user management" },
      { label: "Firmware Broadcast", icon: Radio, href: "/portal/firmware-broadcast", accent: "fuchsia", description: "Batch firmware updates" },
    ]
  },
  {
    group: "NFC & Provisioning",
    items: [
      { label: "NFC Provisioning", icon: Wifi, href: "/portal/nfc", accent: "cyan", description: "Tag provisioning & validation" },
      { label: "Batch Provision", icon: Package, href: "/portal/nfc/batch", accent: "orange", description: "Bulk NFC batch jobs" },
      { label: "Gate QR Scanner", icon: ScanLine, href: "/portal/validate-qr", accent: "violet", description: "Validate station QR codes" },
      { label: "QR Scan Audit Log", icon: History, href: "/portal/qr-scan-logs", accent: "slate", description: "Gate access scan history" },
      { label: "USSD Sessions", icon: Phone, href: "/portal/ussd-sessions", accent: "sky", description: "*346# session replay" },
    ]
  }
];

const ACCENT_COLORS: Record<string, string> = {
  emerald: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  blue: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  amber: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  purple: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  crimson: "bg-red-500/20 text-red-400 border-red-500/30",
  teal: "bg-teal-500/20 text-teal-400 border-teal-500/30",
  indigo: "bg-indigo-500/20 text-indigo-400 border-indigo-500/30",
  rose: "bg-rose-500/20 text-rose-400 border-rose-500/30",
  cyan: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
  orange: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  violet: "bg-violet-500/20 text-violet-400 border-violet-500/30",
  fuchsia: "bg-fuchsia-500/20 text-fuchsia-400 border-fuchsia-500/30",
  slate: "bg-slate-500/20 text-slate-400 border-slate-500/30",
  sky: "bg-sky-500/20 text-sky-400 border-sky-500/30",
};

const ACTIVE_ACCENT: Record<string, string> = {
  emerald: "bg-emerald-500 text-white shadow-lg shadow-emerald-500/30",
  blue: "bg-blue-500 text-white shadow-lg shadow-blue-500/30",
  amber: "bg-amber-500 text-white shadow-lg shadow-amber-500/30",
  purple: "bg-purple-500 text-white shadow-lg shadow-purple-500/30",
  crimson: "bg-red-500 text-white shadow-lg shadow-red-500/30",
  teal: "bg-teal-500 text-white shadow-lg shadow-teal-500/30",
  indigo: "bg-indigo-500 text-white shadow-lg shadow-indigo-500/30",
  rose: "bg-rose-500 text-white shadow-lg shadow-rose-500/30",
  cyan: "bg-cyan-500 text-white shadow-lg shadow-cyan-500/30",
  orange: "bg-orange-500 text-white shadow-lg shadow-orange-500/30",
  violet: "bg-violet-500 text-white shadow-lg shadow-violet-500/30",
  fuchsia: "bg-fuchsia-500 text-white shadow-lg shadow-fuchsia-500/30",
  slate: "bg-slate-500 text-white shadow-lg shadow-slate-500/30",
  sky: "bg-sky-500 text-white shadow-lg shadow-sky-500/30",
};

interface PortalLayoutProps {
  children: React.ReactNode;
  title?: string;
  subtitle?: string;
}

export default function PortalLayout({ children, title, subtitle }: PortalLayoutProps) {
  const [location] = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { user, logout } = useAuth();

  const currentItem = NAV_ITEMS.flatMap(g => g.items).find(i => location.startsWith(i.href));

  const userInitials = user?.phone
    ? user.phone.slice(-4)
    : user?.user_id
    ? user.user_id.slice(0, 2).toUpperCase()
    : "?";

  return (
    <div className="min-h-screen flex bg-[oklch(0.975_0.003_255)]">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={cn(
        "fixed top-0 left-0 h-full w-64 np-sidebar z-50 flex flex-col transition-transform duration-300 lg:translate-x-0 lg:static lg:z-auto",
        sidebarOpen ? "translate-x-0" : "-translate-x-full"
      )}>
        {/* Logo */}
        <div className="px-5 py-5 border-b border-white/10">
          <Link href="/" className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-emerald-500 flex items-center justify-center shadow-lg shadow-emerald-500/30">
              <CheckCircle2 className="w-5 h-5 text-white" />
            </div>
            <div>
              <div className="font-bold text-white text-sm" style={{ fontFamily: 'Sora, sans-serif' }}>NigerianPass</div>
              <div className="text-[10px] text-white/50 uppercase tracking-widest">Onboarding Portal</div>
            </div>
          </Link>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-6">
          {NAV_ITEMS.map(group => (
            <div key={group.group}>
              <div className="px-3 mb-2 text-[10px] font-semibold uppercase tracking-widest text-white/30">
                {group.group}
              </div>
              <div className="space-y-1">
                {group.items.map(item => {
                  const isActive = location.startsWith(item.href);
                  return (
                    <Link key={item.href} href={item.href}>
                      <div
                        className={cn(
                          "flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-all duration-200 group",
                          isActive
                            ? ACTIVE_ACCENT[item.accent]
                            : "text-white/60 hover:text-white hover:bg-white/8"
                        )}
                        onClick={() => setSidebarOpen(false)}
                      >
                        <item.icon className="w-4 h-4 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium truncate">{item.label}</div>
                          <div className={cn("text-[11px] truncate", isActive ? "text-white/80" : "text-white/40 group-hover:text-white/60")}>
                            {item.description}
                          </div>
                        </div>
                        {isActive && <ChevronRight className="w-3 h-3 shrink-0" />}
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* Bottom */}
        <div className="px-3 py-4 border-t border-white/10 space-y-1">
          {/* User info */}
          {user && (
            <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-white/70 mb-1">
              <div className="w-6 h-6 rounded-full bg-emerald-500/30 flex items-center justify-center text-emerald-300 text-[10px] font-bold shrink-0">
                {userInitials}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-white/80 truncate">{user.phone ?? user.user_id}</div>
                <div className="text-[10px] text-white/40 truncate capitalize">{user.role ?? "user"}</div>
              </div>
            </div>
          )}
          <Link href="/settings">
            <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-white/60 hover:text-white hover:bg-white/8 cursor-pointer transition-all">
              <Settings className="w-4 h-4" />
              <span className="text-sm">Settings</span>
            </div>
          </Link>
          <div
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-white/60 hover:text-white hover:bg-white/8 cursor-pointer transition-all"
            onClick={() => {
              if (user) {
                logout();
              } else {
                window.location.href = getLoginUrl();
              }
            }}
          >
            <LogOut className="w-4 h-4" />
            <span className="text-sm">{user ? "Sign Out" : "Sign In"}</span>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header className="h-14 bg-white border-b border-border flex items-center px-4 gap-4 sticky top-0 z-30">
          <button
            className="lg:hidden p-2 rounded-lg hover:bg-muted transition-colors"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu className="w-5 h-5" />
          </button>

          <div className="flex-1 min-w-0">
            {title && (
              <div>
                <h1 className="text-sm font-semibold text-foreground truncate" style={{ fontFamily: 'Sora, sans-serif' }}>
                  {title}
                </h1>
                {subtitle && <p className="text-xs text-muted-foreground truncate">{subtitle}</p>}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            {currentItem && (
              <span className={cn("hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border", ACCENT_COLORS[currentItem.accent])}>
                <currentItem.icon className="w-3 h-3" />
                {currentItem.label}
              </span>
            )}
            <button className="relative p-2 rounded-lg hover:bg-muted transition-colors">
              <Bell className="w-4 h-4 text-muted-foreground" />
              <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 bg-red-500 rounded-full" />
            </button>
            <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-primary-foreground text-xs font-bold">
              {userInitials}
            </div>
          </div>
        </header>

        {/* Page content — add bottom padding on mobile to avoid MobileNav overlap */}
        <main className="flex-1 overflow-auto pb-16 md:pb-0">
          {children}
        </main>
      </div>
    </div>
  );
}
