/**
 * PwaInstallBanner
 *
 * Listens for the browser's `beforeinstallprompt` event and shows a
 * styled install banner. Also handles iOS Safari detection (no event).
 * Dismissed state is persisted in localStorage for 7 days.
 */
import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Download, X, Smartphone, Share } from "lucide-react";
import { Button } from "@/components/ui/button";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = "np_pwa_install_dismissed";
const DISMISS_DAYS = 7;

function isDismissed(): boolean {
  const ts = localStorage.getItem(DISMISS_KEY);
  if (!ts) return false;
  return Date.now() - parseInt(ts, 10) < DISMISS_DAYS * 86_400_000;
}

function isIOS(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) && !(window as any).MSStream;
}

function isInStandaloneMode(): boolean {
  return (window.navigator as any).standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches;
}

export default function PwaInstallBanner() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIosBanner, setShowIosBanner] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (isDismissed() || isInStandaloneMode()) return;

    if (isIOS()) {
      setShowIosBanner(true);
      setVisible(true);
      return;
    }

    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setVisible(true);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  const handleInstall = async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === "accepted") {
      setVisible(false);
    }
    setDeferredPrompt(null);
  };

  const handleDismiss = () => {
    localStorage.setItem(DISMISS_KEY, Date.now().toString());
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ y: 80, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 80, opacity: 0 }}
        transition={{ type: "spring", stiffness: 300, damping: 30 }}
        className="fixed bottom-4 left-4 right-4 z-50 md:left-auto md:right-6 md:w-96"
      >
        <div className="bg-[#1B2B4B] text-white rounded-2xl shadow-2xl border border-white/10 overflow-hidden">
          {/* Gradient accent */}
          <div className="h-1 bg-gradient-to-r from-emerald-500 to-blue-500" />

          <div className="p-4">
            <div className="flex items-start gap-3">
              <div className="w-12 h-12 rounded-xl bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center shrink-0">
                <Smartphone className="w-6 h-6 text-emerald-400" />
              </div>
              <div className="flex-1">
                <div className="flex items-start justify-between">
                  <div>
                    <h4 className="font-bold text-white text-sm" style={{ fontFamily: "Sora, sans-serif" }}>
                      Install NigerianPass
                    </h4>
                    <p className="text-xs text-white/60 mt-0.5">
                      {showIosBanner
                        ? "Add to your Home Screen for the full app experience"
                        : "Install for offline access, push alerts & faster loading"}
                    </p>
                  </div>
                  <button onClick={handleDismiss} className="text-white/40 hover:text-white ml-2">
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {showIosBanner ? (
                  <div className="mt-3 p-3 bg-white/5 rounded-xl border border-white/10">
                    <p className="text-xs text-white/70 flex items-center gap-1.5">
                      <Share className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                      Tap <strong className="text-white">Share</strong> then
                      <strong className="text-white">"Add to Home Screen"</strong>
                    </p>
                  </div>
                ) : (
                  <div className="mt-3 flex gap-2">
                    <Button
                      onClick={handleInstall}
                      size="sm"
                      className="bg-emerald-500 hover:bg-emerald-600 text-white gap-1.5 text-xs flex-1"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Install App
                    </Button>
                    <button
                      onClick={handleDismiss}
                      className="text-xs text-white/50 hover:text-white/80 px-2"
                    >
                      Not now
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
