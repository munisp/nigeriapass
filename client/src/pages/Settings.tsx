/**
 * Settings Page
 * =============
 * User-facing settings for data-saver mode, background sync, notifications,
 * and offline preferences — all critical for Nigerian network conditions.
 */
import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  Gauge, Wifi, Bell, RefreshCw, Shield, Smartphone, ChevronRight,
  ToggleLeft, ToggleRight, Info, CheckCircle, AlertCircle, Clock,
  Database, Zap, WifiOff, Battery, Moon
} from "lucide-react";
import { toast } from "sonner";
import { useDataSaver } from "@/contexts/DataSaverContext";
import { useBackgroundSync } from "@/hooks/useBackgroundSync";
import { getStorageQuota, requestPersistentStorage } from "@/lib/offline";
import PortalLayout from "@/components/PortalLayout";

interface SettingToggleProps {
  label: string;
  description: string;
  enabled: boolean;
  onToggle: () => void;
  badge?: string;
  badgeColor?: string;
  disabled?: boolean;
}

function SettingToggle({ label, description, enabled, onToggle, badge, badgeColor = "bg-green-100 text-green-700", disabled }: SettingToggleProps) {
  return (
    <div className={`flex items-start justify-between gap-4 py-4 ${disabled ? "opacity-50" : ""}`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-900">{label}</span>
          {badge && (
            <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${badgeColor}`}>{badge}</span>
          )}
        </div>
        <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{description}</p>
      </div>
      <button
        onClick={disabled ? undefined : onToggle}
        className={`shrink-0 transition-colors ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
        aria-label={`${enabled ? "Disable" : "Enable"} ${label}`}
      >
        {enabled
          ? <ToggleRight className="w-8 h-8 text-green-600" />
          : <ToggleLeft className="w-8 h-8 text-gray-400" />
        }
      </button>
    </div>
  );
}

interface SettingSectionProps {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}

function SettingSection({ icon, title, children }: SettingSectionProps) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-50 bg-gray-50/50">
        <div className="text-green-600">{icon}</div>
        <h2 className="text-sm font-semibold text-gray-800">{title}</h2>
      </div>
      <div className="px-5 divide-y divide-gray-50">{children}</div>
    </div>
  );
}

export default function Settings() {
  const dataSaver = useDataSaver();
  const bgSync = useBackgroundSync();

  const [storageInfo, setStorageInfo] = useState({ used: 0, quota: 0, percentUsed: 0 });
  const [persistentStorage, setPersistentStorage] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    // Load storage info
    getStorageQuota().then(setStorageInfo);

    // Check persistent storage
    navigator.storage?.persisted?.().then(setPersistentStorage).catch(() => {});

    // Check notification permission
    if ("Notification" in window) {
      setNotificationsEnabled(Notification.permission === "granted");
    }

    // Check reduced motion preference
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
  }, []);

  const handleRequestPersistentStorage = async () => {
    const granted = await requestPersistentStorage();
    setPersistentStorage(granted);
    if (granted) {
      toast.success("Persistent storage granted", {
        description: "Your offline data will not be evicted by the browser.",
      });
    } else {
      toast.error("Persistent storage denied", {
        description: "The browser may evict offline data when storage is low.",
      });
    }
  };

  const handleRequestNotifications = async () => {
    if (!("Notification" in window)) {
      toast.error("Push notifications not supported in this browser.");
      return;
    }
    const permission = await Notification.requestPermission();
    setNotificationsEnabled(permission === "granted");
    if (permission === "granted") {
      toast.success("Notifications enabled");
    } else {
      toast.error("Notification permission denied");
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <PortalLayout title="Settings" subtitle="Connectivity, data, and notification preferences">
      <div className="max-w-2xl mx-auto space-y-4 pb-24">

        {/* Data Saver */}
        <SettingSection icon={<Gauge className="w-5 h-5" />} title="Data Saver">
          <SettingToggle
            label="Data Saver Mode"
            description={
              dataSaver.autoDetected && dataSaver.manualOverride === null
                ? `Auto-detected: ${dataSaver.connectionType.toUpperCase()} connection. Skips map tiles, videos, animations, and compresses photos to ≤200 KB.`
                : "Manually controls data usage. Skips heavy assets and compresses uploads."
            }
            enabled={dataSaver.enabled}
            onToggle={dataSaver.toggle}
            badge={dataSaver.autoDetected && dataSaver.manualOverride === null ? "Auto" : undefined}
            badgeColor="bg-amber-100 text-amber-700"
          />

          {dataSaver.enabled && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              className="pb-4"
            >
              <div className="bg-amber-50 rounded-xl p-3 space-y-2">
                <p className="text-xs font-medium text-amber-800">Active optimisations:</p>
                <div className="grid grid-cols-2 gap-1.5">
                  {[
                    "Map tiles skipped",
                    "Videos disabled",
                    "Animations off",
                    "Photos compressed ≤200 KB",
                    "API polling 2× slower",
                    "Decorative images hidden",
                  ].map(item => (
                    <div key={item} className="flex items-center gap-1.5 text-xs text-amber-700">
                      <CheckCircle className="w-3 h-3 text-amber-500 shrink-0" />
                      {item}
                    </div>
                  ))}
                </div>
                <p className="text-xs text-amber-600 font-medium">
                  ~{dataSaver.estimatedSavingPercent}% less data per session
                </p>
              </div>
            </motion.div>
          )}

          <div className="py-4">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-gray-700">Connection type</span>
              <span className="text-xs font-mono bg-gray-100 text-gray-600 px-2 py-0.5 rounded">
                {dataSaver.connectionType.toUpperCase()}
              </span>
            </div>
            <p className="text-xs text-gray-500">
              Data saver auto-activates on 2G/EDGE or when your browser's Save-Data header is set.
            </p>
          </div>
        </SettingSection>

        {/* Background Sync */}
        <SettingSection icon={<RefreshCw className="w-5 h-5" />} title="Background Sync">
          <SettingToggle
            label="Periodic Background Sync"
            description={
              bgSync.status.periodicSyncSupported
                ? "Refreshes your wallet balance and KYC status every 15–30 minutes, even when the app is closed. Requires Chrome on Android."
                : "Not supported in this browser. Requires Chrome 80+ on Android."
            }
            enabled={bgSync.status.periodicSyncEnabled}
            onToggle={bgSync.status.periodicSyncEnabled ? bgSync.disablePeriodicSync : bgSync.enablePeriodicSync}
            disabled={!bgSync.status.periodicSyncSupported}
            badge={bgSync.status.periodicSyncSupported ? undefined : "Unsupported"}
            badgeColor="bg-gray-100 text-gray-500"
          />

          <div className="py-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-gray-700">Background Sync API</span>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                bgSync.status.backgroundSyncSupported
                  ? "bg-green-100 text-green-700"
                  : "bg-gray-100 text-gray-500"
              }`}>
                {bgSync.status.backgroundSyncSupported ? "Supported" : "Unsupported"}
              </span>
            </div>

            {bgSync.status.lastSyncAt && (
              <div className="flex items-center gap-2 text-xs text-gray-500">
                <Clock className="w-3.5 h-3.5" />
                Last sync: {new Date(bgSync.status.lastSyncAt).toLocaleTimeString()}
              </div>
            )}

            {bgSync.status.lastBalanceRefreshAt && (
              <div className="flex items-center gap-2 text-xs text-gray-500">
                <Zap className="w-3.5 h-3.5" />
                Balance refreshed: {new Date(bgSync.status.lastBalanceRefreshAt).toLocaleTimeString()}
              </div>
            )}

            <button
              onClick={bgSync.triggerRetryQueue}
              disabled={bgSync.status.isSyncing}
              className="flex items-center gap-2 text-xs font-medium text-green-700 bg-green-50 hover:bg-green-100 px-3 py-2 rounded-lg transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${bgSync.status.isSyncing ? "animate-spin" : ""}`} />
              {bgSync.status.isSyncing ? "Syncing…" : "Sync offline queue now"}
            </button>
          </div>
        </SettingSection>

        {/* Notifications */}
        <SettingSection icon={<Bell className="w-5 h-5" />} title="Notifications">
          <SettingToggle
            label="Push Notifications"
            description="Receive native OS notifications for KYC approvals, rejections, and low wallet balance alerts — even when the app is in the background."
            enabled={notificationsEnabled}
            onToggle={notificationsEnabled
              ? () => toast.info("To disable, revoke permission in browser settings.")
              : handleRequestNotifications
            }
          />
        </SettingSection>

        {/* Offline Storage */}
        <SettingSection icon={<Database className="w-5 h-5" />} title="Offline Storage">
          <div className="py-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-gray-700">Storage used</span>
              <span className="text-xs font-mono text-gray-600">
                {formatBytes(storageInfo.used)} / {formatBytes(storageInfo.quota)}
              </span>
            </div>

            {storageInfo.quota > 0 && (
              <div className="w-full bg-gray-100 rounded-full h-1.5">
                <div
                  className="bg-green-500 h-1.5 rounded-full transition-all"
                  style={{ width: `${Math.min(storageInfo.percentUsed, 100)}%` }}
                />
              </div>
            )}

            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-gray-700">Persistent storage</span>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                persistentStorage ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"
              }`}>
                {persistentStorage ? "Granted" : "Not granted"}
              </span>
            </div>

            {!persistentStorage && (
              <div className="bg-amber-50 rounded-xl p-3">
                <p className="text-xs text-amber-700 mb-2">
                  Without persistent storage, the browser may delete your offline drafts when storage is low.
                  This is especially important during power outages.
                </p>
                <button
                  onClick={handleRequestPersistentStorage}
                  className="text-xs font-medium text-amber-800 bg-amber-200 hover:bg-amber-300 px-3 py-1.5 rounded-lg transition-colors"
                >
                  Request persistent storage
                </button>
              </div>
            )}
          </div>
        </SettingSection>

        {/* Accessibility */}
        <SettingSection icon={<Moon className="w-5 h-5" />} title="Accessibility">
          <div className="py-4">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-sm font-medium text-gray-900">Reduced motion</span>
                <p className="text-xs text-gray-500 mt-0.5">
                  {reducedMotion
                    ? "Detected from OS settings. Animations are minimised."
                    : "Your OS has animations enabled. Toggle in OS Accessibility settings."}
                </p>
              </div>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                reducedMotion ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-500"
              }`}>
                {reducedMotion ? "Active" : "Inactive"}
              </span>
            </div>
          </div>
        </SettingSection>

        {/* About */}
        <div className="bg-gray-50 rounded-2xl p-4 text-center">
          <p className="text-xs text-gray-500">
            NigerianPass Onboarding Portal · v1.0.0
          </p>
          <p className="text-xs text-gray-400 mt-1">
            Optimised for Nigerian network conditions · Works offline
          </p>
        </div>
      </div>
    </PortalLayout>
  );
}
