/**
 * PushNotificationPrompt
 *
 * Shown as a dismissible banner after login.
 * Calls usePushNotifications to request permission and manage state.
 */
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Bell, BellOff, X, Loader2, CheckCircle2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePushNotifications } from "@/hooks/usePushNotifications";
import { cn } from "@/lib/utils";

interface PushNotificationPromptProps {
  onDismiss?: () => void;
  compact?: boolean;
}

export default function PushNotificationPrompt({ onDismiss, compact = false }: PushNotificationPromptProps) {
  const { permission, isSubscribed, isLoading, requestPermission, sendTestNotification, unsubscribe } =
    usePushNotifications();
  const [dismissed, setDismissed] = useState(false);

  const handleDismiss = () => {
    setDismissed(true);
    onDismiss?.();
  };

  if (permission === "unsupported") return null;
  if (dismissed) return null;

  // Already subscribed — show compact status
  if (isSubscribed && permission === "granted") {
    if (compact) return null;
    return (
      <AnimatePresence>
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          className="flex items-center gap-3 p-3 bg-emerald-50 border border-emerald-200 rounded-xl"
        >
          <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
          <div className="flex-1 text-sm text-emerald-800">
            <span className="font-medium">Push alerts active.</span>{" "}
            You'll be notified of KYC updates and low-balance alerts.
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={sendTestNotification}
              className="text-xs text-emerald-700 underline underline-offset-2 hover:text-emerald-900"
            >
              Test
            </button>
            <button
              onClick={unsubscribe}
              className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              Disable
            </button>
          </div>
        </motion.div>
      </AnimatePresence>
    );
  }

  // Denied — show info
  if (permission === "denied") {
    if (compact) return null;
    return (
      <div className="flex items-center gap-3 p-3 bg-amber-50 border border-amber-200 rounded-xl">
        <BellOff className="w-4 h-4 text-amber-600 shrink-0" />
        <p className="text-sm text-amber-800 flex-1">
          Notifications blocked. Enable them in your browser settings to receive KYC alerts.
        </p>
        <button onClick={handleDismiss} className="text-muted-foreground hover:text-foreground">
          <X className="w-4 h-4" />
        </button>
      </div>
    );
  }

  // Default — prompt to enable
  if (compact) {
    return (
      <button
        onClick={requestPermission}
        disabled={isLoading}
        className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-800 font-medium"
      >
        {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Bell className="w-4 h-4" />}
        Enable push alerts
      </button>
    );
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -10, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -10, scale: 0.98 }}
        transition={{ duration: 0.25 }}
        className="relative overflow-hidden bg-gradient-to-r from-blue-600 to-blue-700 rounded-2xl p-5 text-white shadow-lg"
      >
        {/* Background pattern */}
        <div className="absolute inset-0 opacity-10">
          <div className="absolute top-2 right-8 w-24 h-24 rounded-full border-4 border-white" />
          <div className="absolute -bottom-4 right-4 w-16 h-16 rounded-full border-4 border-white" />
        </div>

        <button
          onClick={handleDismiss}
          className="absolute top-3 right-3 text-white/60 hover:text-white transition-colors"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="flex items-start gap-4 relative">
          <div className="w-10 h-10 rounded-xl bg-white/20 flex items-center justify-center shrink-0">
            <Bell className="w-5 h-5 text-white" />
          </div>
          <div className="flex-1">
            <h4 className="font-bold text-white mb-1" style={{ fontFamily: "Sora, sans-serif" }}>
              Stay updated on your KYC status
            </h4>
            <p className="text-sm text-blue-100 mb-3">
              Enable push notifications to receive instant alerts when your application is approved, rejected, or requires action — even when the app is in the background.
            </p>
            <div className="flex items-center gap-3 flex-wrap">
              <Button
                onClick={requestPermission}
                disabled={isLoading}
                size="sm"
                className="bg-white text-blue-700 hover:bg-blue-50 gap-2 font-semibold"
              >
                {isLoading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Bell className="w-3.5 h-3.5" />
                )}
                Enable Notifications
              </Button>
              <button
                onClick={handleDismiss}
                className="text-sm text-blue-200 hover:text-white transition-colors"
              >
                Maybe later
              </button>
            </div>
          </div>
        </div>

        {/* Alert types */}
        <div className="mt-4 pt-4 border-t border-white/20 grid grid-cols-3 gap-3 relative">
          {[
            { icon: CheckCircle2, label: "KYC Approved" },
            { icon: X, label: "Rejection Alert" },
            { icon: Send, label: "Low Balance" },
          ].map(item => (
            <div key={item.label} className="flex items-center gap-1.5">
              <item.icon className="w-3.5 h-3.5 text-blue-200 shrink-0" />
              <span className="text-xs text-blue-100">{item.label}</span>
            </div>
          ))}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
