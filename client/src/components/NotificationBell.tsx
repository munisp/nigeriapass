/**
 * NigerianPass Notification Bell
 * Displays real-time push notifications in a popover dropdown.
 * Connects to useNotifications hook (WebSocket + polling fallback).
 */
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Bell, CheckCheck, ExternalLink, Shield, Zap, AlertTriangle, Info, X } from "lucide-react";
import { useNotifications } from "@/hooks/useNotifications";
import { type AppNotification } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useLocation } from "wouter";

const TYPE_CONFIG: Record<AppNotification["type"], { icon: typeof Bell; color: string; bg: string }> = {
  kyc_approved:     { icon: Shield,        color: "text-emerald-600", bg: "bg-emerald-50" },
  kyc_rejected:     { icon: AlertTriangle, color: "text-red-600",     bg: "bg-red-50" },
  kyc_review:       { icon: Info,          color: "text-blue-600",    bg: "bg-blue-50" },
  vehicle_approved: { icon: Shield,        color: "text-emerald-600", bg: "bg-emerald-50" },
  fleet_approved:   { icon: Shield,        color: "text-emerald-600", bg: "bg-emerald-50" },
  toll_charge:      { icon: Zap,           color: "text-amber-600",   bg: "bg-amber-50" },
  low_balance:      { icon: AlertTriangle, color: "text-orange-600",  bg: "bg-orange-50" },
  system:           { icon: Info,          color: "text-slate-600",   bg: "bg-slate-50" },
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const { notifications, unreadCount, isConnected, markRead, markAllRead } = useNotifications();
  const [, navigate] = useLocation();

  const handleNotificationClick = async (n: AppNotification) => {
    if (!n.read) await markRead(n.id);
    if (n.reference) {
      if (n.type.startsWith("kyc") || n.type === "vehicle_approved" || n.type === "fleet_approved") {
        navigate(`/status/${n.reference}`);
        setOpen(false);
      }
    }
  };

  return (
    <div className="relative">
      {/* Bell button */}
      <button
        onClick={() => setOpen(o => !o)}
        className={cn(
          "relative w-9 h-9 rounded-xl flex items-center justify-center transition-all",
          "hover:bg-muted border border-transparent hover:border-border",
          open && "bg-muted border-border"
        )}
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ""}`}
      >
        <Bell className="w-4 h-4 text-muted-foreground" />
        {unreadCount > 0 && (
          <motion.span
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center"
          >
            {unreadCount > 9 ? "9+" : unreadCount}
          </motion.span>
        )}
        {/* Live WS indicator dot */}
        {isConnected && (
          <span className="absolute bottom-0.5 right-0.5 w-1.5 h-1.5 bg-emerald-500 rounded-full" />
        )}
      </button>

      {/* Dropdown panel */}
      <AnimatePresence>
        {open && (
          <>
            {/* Backdrop */}
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />

            <motion.div
              initial={{ opacity: 0, y: -8, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.97 }}
              transition={{ duration: 0.15 }}
              className="absolute right-0 top-11 w-80 sm:w-96 bg-white border border-border rounded-2xl shadow-xl z-50 overflow-hidden"
            >
              {/* Header */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm text-foreground">Notifications</span>
                  {isConnected && (
                    <span className="flex items-center gap-1 text-[10px] text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded-full">
                      <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" />
                      Live
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {unreadCount > 0 && (
                    <button
                      onClick={markAllRead}
                      className="text-xs text-primary hover:underline flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-primary/5"
                    >
                      <CheckCheck className="w-3 h-3" />
                      Mark all read
                    </button>
                  )}
                  <button onClick={() => setOpen(false)} className="p-1 rounded-lg hover:bg-muted text-muted-foreground">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Notification list */}
              <div className="max-h-96 overflow-y-auto divide-y divide-border">
                {notifications.length === 0 ? (
                  <div className="py-12 text-center">
                    <Bell className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" />
                    <p className="text-sm text-muted-foreground">No notifications yet</p>
                  </div>
                ) : (
                  notifications.map(n => {
                    const cfg = TYPE_CONFIG[n.type] ?? TYPE_CONFIG.system;
                    const Icon = cfg.icon;
                    return (
                      <button
                        key={n.id}
                        onClick={() => handleNotificationClick(n)}
                        className={cn(
                          "w-full text-left px-4 py-3 flex gap-3 hover:bg-muted/50 transition-colors",
                          !n.read && "bg-blue-50/50"
                        )}
                      >
                        <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5", cfg.bg)}>
                          <Icon className={cn("w-4 h-4", cfg.color)} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-2">
                            <p className={cn("text-sm font-medium leading-tight", !n.read ? "text-foreground" : "text-muted-foreground")}>
                              {n.title}
                            </p>
                            <span className="text-[10px] text-muted-foreground flex-shrink-0 mt-0.5">
                              {timeAgo(n.created_at)}
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed line-clamp-2">
                            {n.message}
                          </p>
                          {n.reference && (
                            <span className="inline-flex items-center gap-1 text-[10px] text-primary mt-1">
                              <ExternalLink className="w-2.5 h-2.5" />
                              {n.reference}
                            </span>
                          )}
                        </div>
                        {!n.read && (
                          <span className="w-2 h-2 bg-blue-500 rounded-full flex-shrink-0 mt-2" />
                        )}
                      </button>
                    );
                  })
                )}
              </div>

              {/* Footer */}
              <div className="px-4 py-2.5 border-t border-border bg-muted/30">
                <p className="text-[10px] text-muted-foreground text-center">
                  {isConnected ? "Real-time updates active" : "Updates every 30 seconds"}
                </p>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
