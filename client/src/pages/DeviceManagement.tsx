import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import {
  Cpu, Wifi, WifiOff, AlertTriangle, CheckCircle2, CheckCircle, RefreshCw,
  Download, Settings, Activity, HardDrive, Zap,
  Plus, Search, MapPin, Loader2, Trash2, Radio, QrCode, X,
  ShieldCheck, FileText, Printer, RotateCcw, Clock, History,
} from "lucide-react";
import { useEffect as _useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import PortalLayout from "@/components/PortalLayout";
import { useDeviceHeartbeat } from "@/hooks/useDeviceHeartbeat";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { QRCodeSVG } from "qrcode.react";

type DeviceStatus = "online" | "offline" | "warning" | "maintenance";

interface Device {
  id: string;
  serial: string;
  name: string;
  type: "nfc_reader" | "barrier" | "camera" | "display" | "edge_unit";
  plaza: string;
  lane: string;
  status: DeviceStatus;
  firmware: string;
  latestFirmware: string;
  uptime: string;
  cpu: number;
  memory: number;
  temp: number;
  lastSeen: string;
  alerts: number;
}

interface QrCodeData {
  qrUri: string;
  serial: string;
  name: string;
  plaza: string;
  lane: string;
  generatedAt: string;
  expiresAt?: string;
  ttlHours?: number;
}

interface AlertLogEntry {
  id: number;
  deviceId: number;
  serial: string;
  plaza: string;
  alertsCleared: number;
  note: string | null;
  resolvedByName: string | null;
  resolvedAt: Date;
}

interface ResolveAlertState {
  deviceId: string;
  deviceName: string;
  alertCount: number;
  note: string;
}

const STATUS_CONFIG: Record<DeviceStatus, { label: string; color: string; icon: React.ElementType }> = {
  online: { label: "Online", color: "text-emerald-600 bg-emerald-50 border-emerald-200", icon: CheckCircle2 },
  offline: { label: "Offline", color: "text-red-600 bg-red-50 border-red-200", icon: WifiOff },
  warning: { label: "Warning", color: "text-amber-600 bg-amber-50 border-amber-200", icon: AlertTriangle },
  maintenance: { label: "Maintenance", color: "text-blue-600 bg-blue-50 border-blue-200", icon: Settings },
};

const TYPE_LABELS: Record<Device["type"], string> = {
  nfc_reader: "NFC Reader", barrier: "Boom Barrier", camera: "ANPR Camera",
  display: "LED Display", edge_unit: "Edge Unit",
};

export default function DeviceManagement() {
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<DeviceStatus | "all">("all");
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null);
  const [updatingFirmware, setUpdatingFirmware] = useState<string | null>(null);
  const [simulatingSerial, setSimulatingSerial] = useState<string | null>(null);
  const [qrModal, setQrModal] = useState<QrCodeData | null>(null);
  const [resolveModal, setResolveModal] = useState<ResolveAlertState | null>(null);
  const [printingPlaza, setPrintingPlaza] = useState<string | null>(null);
  const [historyDeviceId, setHistoryDeviceId] = useState<number | null>(null);
  const [rotatingSerial, setRotatingSerial] = useState<string | null>(null);
  const [qrCountdown, setQrCountdown] = useState<string | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  // Real-time WebSocket heartbeat
  const { devices: liveDevices, connected: wsConnected, lastUpdate, error: wsError, refresh } = useDeviceHeartbeat();

  // tRPC queries and mutations
  const devicesQuery = trpc.devices.list.useQuery({ status: filterStatus, search: search || undefined });
  const plazaQuery = trpc.devices.plazaSummary.useQuery();
  const utils = trpc.useUtils();

  const deleteMutation = trpc.devices.delete.useMutation({
    onSuccess: () => { utils.devices.list.invalidate(); toast.success("Device deleted"); },
    onError: (err) => toast.error(err.message),
  });

  const updateMutation = trpc.devices.update.useMutation({
    onSuccess: () => { utils.devices.list.invalidate(); toast.success("Device updated"); },
    onError: (err) => toast.error(err.message),
  });

  const seedMutation = trpc.devices.seed.useMutation({
    onSuccess: (data) => {
      toast.success(data.message);
      utils.devices.list.invalidate();
      utils.devices.plazaSummary.invalidate();
    },
    onError: (err) => toast.error(`Seed failed: ${err.message}`),
  });

  const simulateHeartbeatMutation = trpc.devices.simulateHeartbeat.useMutation({
    onSuccess: (data) => {
      toast.success(`Heartbeat sent for ${data.serial}`);
      setSimulatingSerial(null);
    },
    onError: (err) => {
      toast.error(`Heartbeat failed: ${err.message}`);
      setSimulatingSerial(null);
    },
  });

  const getPlazaQrCodeMutation = trpc.devices.getPlazaQrCode.useMutation({
    onSuccess: (data) => {
      setQrModal(data);
      setQrCountdown(null);
      toast.success("QR code generated");
    },
    onError: (err) => toast.error(`QR generation failed: ${err.message}`),
  });

  const printPlazaQrSheetMutation = trpc.devices.printPlazaQrSheet.useMutation({
    onSuccess: (data) => {
      // Decode base64 PDF and trigger download
      const bytes = Uint8Array.from(atob(data.pdfBase64), c => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = data.filename;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Downloaded QR sheet for ${data.readerCount} NFC reader${data.readerCount !== 1 ? "s" : ""}`);
      setPrintingPlaza(null);
    },
    onError: (err) => {
      toast.error(`Print failed: ${err.message}`);
      setPrintingPlaza(null);
    },
  });

  // Alert history query (lazy — only fires when historyDeviceId is set)
  const alertHistoryQuery = trpc.devices.getAlertHistory.useQuery(
    { deviceId: historyDeviceId ?? 0 },
    { enabled: historyDeviceId !== null },
  );

  // Rotate QR code mutation
  const rotateQrCodeMutation = trpc.devices.rotateQrCode.useMutation({
    onSuccess: (data) => {
      setQrModal(data);
      setRotatingSerial(null);
      toast.success(`QR rotated — expires ${new Date(data.expiresAt).toLocaleString()}`);
      // Start countdown timer
      if (countdownRef.current) clearInterval(countdownRef.current);
      countdownRef.current = setInterval(() => {
        const remaining = new Date(data.expiresAt).getTime() - Date.now();
        if (remaining <= 0) {
          setQrCountdown("Expired");
          clearInterval(countdownRef.current!);
        } else {
          const h = Math.floor(remaining / 3_600_000);
          const m = Math.floor((remaining % 3_600_000) / 60_000);
          const s = Math.floor((remaining % 60_000) / 1_000);
          setQrCountdown(`${h}h ${m}m ${s}s`);
        }
      }, 1_000);
    },
    onError: (err) => {
      toast.error(`Rotate failed: ${err.message}`);
      setRotatingSerial(null);
    },
  });

  const resolveAlertMutation = trpc.devices.resolveAlert.useMutation({
    onSuccess: (data) => {
      toast.success(`Resolved ${data.alertsCleared} alert${data.alertsCleared !== 1 ? "s" : ""} on ${data.serial}`);
      utils.devices.list.invalidate();
      utils.devices.plazaSummary.invalidate();
      setResolveModal(null);
      // Update selected device alert count locally
      setSelectedDevice(prev => prev && prev.id === resolveModal?.deviceId ? { ...prev, alerts: 0 } : prev);
    },
    onError: (err) => toast.error(`Resolve failed: ${err.message}`),
  });

  // Map DB rows to local Device shape, then overlay live heartbeat data
  const dbDevices: Device[] = (devicesQuery.data?.devices ?? []).map(d => ({
    id: String(d.id),
    serial: d.serial,
    name: d.name,
    type: d.type as Device["type"],
    plaza: d.plaza,
    lane: d.lane,
    status: d.status as DeviceStatus,
    firmware: d.firmware,
    latestFirmware: d.latestFirmware,
    uptime: d.uptime,
    cpu: d.cpu,
    memory: d.memory,
    temp: d.temp,
    lastSeen: new Date(d.lastSeen).toLocaleTimeString(),
    alerts: d.alerts,
  }));

  const [devices, setDevices] = useState<Device[]>([]);

  // Merge DB data with live heartbeat overlay
  useEffect(() => {
    if (dbDevices.length > 0) {
      setDevices(dbDevices.map(d => {
        const live = liveDevices.find(l => l.serial === d.serial || l.device_id === d.id);
        if (!live) return d;
        return {
          ...d,
          status: (live.status as DeviceStatus) ?? d.status,
          cpu: live.cpu_percent ?? d.cpu,
          memory: live.memory_percent ?? d.memory,
          temp: live.temperature_celsius ?? d.temp,
          lastSeen: live.timestamp ? new Date(live.timestamp).toLocaleTimeString() : d.lastSeen,
        };
      }));
    } else if (dbDevices.length === 0 && !devicesQuery.isLoading) {
      setDevices([]);
    }
  }, [devicesQuery.data, liveDevices]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = devices.filter(d => {
    const matchSearch = !search || d.name.toLowerCase().includes(search.toLowerCase()) ||
      d.serial.toLowerCase().includes(search.toLowerCase()) ||
      d.plaza.toLowerCase().includes(search.toLowerCase());
    const matchStatus = filterStatus === "all" || d.status === filterStatus;
    return matchSearch && matchStatus;
  });

  const reportFirmwareVersionMutation = trpc.devices.reportFirmwareVersion.useMutation({
    onSuccess: (data) => {
      toast.success(`Firmware reported: ${data.serial} now on v${data.currentFirmware}${data.isUpToDate ? " (up to date)" : ""}`);
      utils.devices.list.invalidate();
    },
    onError: (err) => toast.error(`Failed to report firmware: ${err.message}`),
  });

  const triggerFirmwareUpdateMutation = trpc.devices.triggerFirmwareUpdate.useMutation({
    onSuccess: (data) => {
      toast.success(`Firmware update requested: ${data.serial} ${data.currentFirmware} → ${data.targetVersion}`);
      utils.devices.list.invalidate();
    },
    onError: (err) => toast.error(`Firmware update failed: ${err.message}`),
  });

  const handleFirmwareUpdate = async (deviceId: string) => {
    setUpdatingFirmware(deviceId);
    const device = devices.find(d => d.id === deviceId);
    if (device) {
      try {
        await triggerFirmwareUpdateMutation.mutateAsync({
          serial: device.serial,
          targetVersion: device.latestFirmware,
        });
      } catch { /* error handled in onError */ }
    }
    setUpdatingFirmware(null);
  };

  const handleReboot = async (deviceId: string) => {
    toast.info("Reboot command sent to device");
    await updateMutation.mutateAsync({ id: parseInt(deviceId), data: { status: "offline" } });
    setTimeout(() => {
      updateMutation.mutate({ id: parseInt(deviceId), data: { status: "online" } });
    }, 3000);
  };

  const handleDelete = async (deviceId: string) => {
    if (!confirm("Delete this device? This cannot be undone.")) return;
    await deleteMutation.mutateAsync({ id: parseInt(deviceId) });
    if (selectedDevice?.id === deviceId) setSelectedDevice(null);
  };

  const handleSimulateHeartbeat = useCallback((device: Device, e: React.MouseEvent) => {
    e.stopPropagation();
    setSimulatingSerial(device.serial);
    simulateHeartbeatMutation.mutate({
      serial: device.serial,
      status: "online",
      cpu: Math.round(20 + Math.random() * 50),
      memory: Math.round(30 + Math.random() * 40),
      temp: Math.round(35 + Math.random() * 20),
    });
  }, [simulateHeartbeatMutation]);

  const handleGenerateQrCode = useCallback((device: Device, e: React.MouseEvent) => {
    e.stopPropagation();
    getPlazaQrCodeMutation.mutate({ serial: device.serial });
  }, [getPlazaQrCodeMutation]);

  const handlePrintPlazaQrSheet = useCallback((plaza: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setPrintingPlaza(plaza);
    printPlazaQrSheetMutation.mutate({ plaza });
  }, [printPlazaQrSheetMutation]);

  const handleResolveAlert = useCallback((device: Device, e: React.MouseEvent) => {
    e.stopPropagation();
    setResolveModal({ deviceId: device.id, deviceName: device.name, alertCount: device.alerts, note: "" });
  }, []);

  const handleDownloadQr = useCallback(() => {
    if (!qrModal) return;
    const svg = document.getElementById("plaza-qr-svg");
    if (!svg) return;
    const svgData = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([svgData], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `nigerianpass-qr-${qrModal.serial}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  }, [qrModal]);

  const stats = {
    total: devices.length,
    online: devices.filter(d => d.status === "online").length,
    warning: devices.filter(d => d.status === "warning").length,
    offline: devices.filter(d => d.status === "offline").length,
    maintenance: devices.filter(d => d.status === "maintenance").length,
    needsUpdate: devices.filter(d => d.firmware !== d.latestFirmware).length,
  };

  // No simulated metric fluctuation — when no live heartbeat stream is
  // connected, the UI shows the last server-fetched snapshot unchanged and the
  // banner below reports the disconnected state honestly.

  return (
    <PortalLayout title="Device Management" subtitle="Monitor and manage all toll booth hardware">
      <div className="p-4 md:p-6 lg:p-8 space-y-6">

        {/* Live connection status banner */}
        <div className={cn(
          "flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-medium border",
          wsConnected
            ? "bg-emerald-50 border-emerald-200 text-emerald-700"
            : wsError
            ? "bg-amber-50 border-amber-200 text-amber-700"
            : "bg-muted border-border text-muted-foreground"
        )}>
          <span className={cn(
            "w-2 h-2 rounded-full",
            wsConnected ? "bg-emerald-500 animate-pulse" : wsError ? "bg-amber-500" : "bg-muted-foreground"
          )} />
          {wsConnected
            ? `Live WebSocket connected — metrics updating in real-time${lastUpdate ? ` · Last: ${lastUpdate.toLocaleTimeString()}` : ""}`
            : wsError
            ? `${wsError} · Showing last known server snapshot (no live metrics)`
            : "Connecting to device heartbeat stream..."}
          <button onClick={() => refresh()} className="ml-auto hover:text-foreground transition-colors">
            <RefreshCw className="w-3 h-3" />
          </button>
        </div>

        {/* Stats Row */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            { label: "Total Devices", value: stats.total, color: "text-foreground", bg: "bg-muted" },
            { label: "Online", value: stats.online, color: "text-emerald-700", bg: "bg-emerald-50 border border-emerald-200" },
            { label: "Warning", value: stats.warning, color: "text-amber-700", bg: "bg-amber-50 border border-amber-200" },
            { label: "Offline", value: stats.offline, color: "text-red-700", bg: "bg-red-50 border border-red-200" },
            { label: "Maintenance", value: stats.maintenance, color: "text-blue-700", bg: "bg-blue-50 border border-blue-200" },
            { label: "Needs Update", value: stats.needsUpdate, color: "text-purple-700", bg: "bg-purple-50 border border-purple-200" },
          ].map(s => (
            <motion.div key={s.label} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
              className={cn("rounded-xl p-3 text-center", s.bg)}>
              <div className={cn("text-2xl font-bold", s.color)}>{s.value}</div>
              <div className="text-xs text-muted-foreground mt-0.5">{s.label}</div>
            </motion.div>
          ))}
        </div>

        {/* Plaza Summary with Print All QRs button */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {(plazaQuery.data ?? []).map(plaza => (
            <div key={plaza.plaza} className="bg-white rounded-2xl border border-border p-4 shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <MapPin className="w-4 h-4 text-primary" />
                  <span className="font-semibold text-sm">{plaza.plaza}</span>
                </div>
                {isAdmin && (
                  <Button size="sm" variant="outline"
                    className="h-7 text-xs gap-1 text-blue-600 border-blue-200 hover:bg-blue-50"
                    onClick={(e) => handlePrintPlazaQrSheet(plaza.plaza, e)}
                    disabled={printingPlaza === plaza.plaza}>
                    {printingPlaza === plaza.plaza
                      ? <Loader2 className="w-3 h-3 animate-spin" />
                      : <Printer className="w-3 h-3" />}
                    Print All QRs
                  </Button>
                )}
              </div>
              <div className="flex gap-3">
                <div className="flex-1 text-center p-2 bg-emerald-50 rounded-lg">
                  <div className="text-lg font-bold text-emerald-700">{plaza.online}</div>
                  <div className="text-[10px] text-emerald-600">Online</div>
                </div>
                <div className="flex-1 text-center p-2 bg-amber-50 rounded-lg">
                  <div className="text-lg font-bold text-amber-700">{plaza.warning}</div>
                  <div className="text-[10px] text-amber-600">Warning</div>
                </div>
                <div className="flex-1 text-center p-2 bg-red-50 rounded-lg">
                  <div className="text-lg font-bold text-red-700">{plaza.offline}</div>
                  <div className="text-[10px] text-red-600">Offline</div>
                </div>
                <div className="flex-1 text-center p-2 bg-muted rounded-lg">
                  <div className="text-lg font-bold text-foreground">{plaza.total}</div>
                  <div className="text-[10px] text-muted-foreground">Total</div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Device List */}
        <div className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex items-center gap-3 flex-wrap">
            <div className="relative flex-1 min-w-48">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search devices, serials, plazas..." className="pl-9 h-9" />
            </div>
            <div className="flex gap-1.5">
              {(["all", "online", "warning", "offline", "maintenance"] as const).map(s => (
                <button key={s} onClick={() => setFilterStatus(s)}
                  className={cn("px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-all",
                    filterStatus === s ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/80")}>
                  {s}
                </button>
              ))}
            </div>
            {isAdmin && (
              <Button size="sm" variant="outline" className="h-9 gap-1.5"
                onClick={() => seedMutation.mutate({ force: false })}
                disabled={seedMutation.isPending}>
                {seedMutation.isPending ? "Seeding..." : "Seed Plazas"}
              </Button>
            )}
            <Button size="sm" className="h-9 gap-1.5 bg-blue-600 hover:bg-blue-700">
              <Plus className="w-4 h-4" />Add Device
            </Button>
          </div>

          <div className="divide-y divide-border">
            {filtered.map(device => {
              const statusCfg = STATUS_CONFIG[device.status];
              const StatusIcon = statusCfg.icon;
              const needsUpdate = device.firmware !== device.latestFirmware;
              const isUpdating = updatingFirmware === device.id;
              const isSimulating = simulatingSerial === device.serial;

              return (
                <motion.div key={device.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                  className="p-4 hover:bg-muted/30 transition-colors cursor-pointer"
                  onClick={() => setSelectedDevice(selectedDevice?.id === device.id ? null : device)}>
                  <div className="flex items-center gap-4">
                    {/* Device Icon */}
                    <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center shrink-0",
                      device.status === "online" ? "bg-emerald-100" :
                      device.status === "warning" ? "bg-amber-100" :
                      device.status === "offline" ? "bg-red-100" : "bg-blue-100")}>
                      {device.type === "nfc_reader" ? <Wifi className="w-5 h-5" /> :
                       device.type === "barrier" ? <Zap className="w-5 h-5" /> :
                       device.type === "camera" ? <Activity className="w-5 h-5" /> :
                       device.type === "edge_unit" ? <Cpu className="w-5 h-5" /> :
                       <HardDrive className="w-5 h-5" />}
                    </div>

                    {/* Device Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm">{device.name}</span>
                        <span className={cn("text-[10px] px-2 py-0.5 rounded-full border font-medium flex items-center gap-1", statusCfg.color)}>
                          <StatusIcon className="w-3 h-3" />{statusCfg.label}
                        </span>
                        {needsUpdate && <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-50 border border-purple-200 text-purple-600 font-medium">Update Available</span>}
                        {device.alerts > 0 && (
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-50 border border-red-200 text-red-600 font-medium">
                            {device.alerts} Alert{device.alerts > 1 ? "s" : ""}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground flex-wrap">
                        <span>{device.serial}</span>
                        <span>·</span>
                        <span>{device.plaza}</span>
                        <span>·</span>
                        <span>{device.lane}</span>
                        <span>·</span>
                        <span>v{device.firmware}</span>
                        <span>·</span>
                        <span>Last seen: {device.lastSeen}</span>
                      </div>
                    </div>

                    {/* Metrics */}
                    {device.status === "online" && (
                      <div className="hidden md:flex items-center gap-4 shrink-0">
                        <div className="text-center">
                          <div className={cn("text-sm font-bold", device.cpu > 80 ? "text-red-600" : device.cpu > 60 ? "text-amber-600" : "text-emerald-600")}>{Math.round(device.cpu)}%</div>
                          <div className="text-[10px] text-muted-foreground">CPU</div>
                        </div>
                        <div className="text-center">
                          <div className={cn("text-sm font-bold", device.memory > 80 ? "text-red-600" : device.memory > 60 ? "text-amber-600" : "text-emerald-600")}>{Math.round(device.memory)}%</div>
                          <div className="text-[10px] text-muted-foreground">MEM</div>
                        </div>
                        <div className="text-center">
                          <div className={cn("text-sm font-bold", device.temp > 70 ? "text-red-600" : device.temp > 55 ? "text-amber-600" : "text-emerald-600")}>{Math.round(device.temp)}°C</div>
                          <div className="text-[10px] text-muted-foreground">TEMP</div>
                        </div>
                      </div>
                    )}

                    {/* Row Actions */}
                    <div className="flex items-center gap-1.5 shrink-0" onClick={e => e.stopPropagation()}>
                      {needsUpdate && (
                        <Button size="sm" variant="outline" className="h-7 text-xs gap-1 text-purple-600 border-purple-200 hover:bg-purple-50"
                          onClick={() => handleFirmwareUpdate(device.id)} disabled={isUpdating}>
                          {isUpdating ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                          {isUpdating ? "Updating..." : "Update"}
                        </Button>
                      )}
                      {isAdmin && (
                        <>
                          {device.alerts > 0 && (
                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-orange-500 hover:text-orange-700 hover:bg-orange-50"
                              onClick={(e) => handleResolveAlert(device, e)}
                              title="Resolve alerts">
                              <ShieldCheck className="w-3.5 h-3.5" />
                            </Button>
                          )}
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50"
                            onClick={(e) => handleSimulateHeartbeat(device, e)}
                            disabled={isSimulating}
                            title="Simulate heartbeat">
                            {isSimulating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Radio className="w-3.5 h-3.5" />}
                          </Button>
                          {device.type === "nfc_reader" && (
                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                              onClick={(e) => handleGenerateQrCode(device, e)}
                              disabled={getPlazaQrCodeMutation.isPending}
                              title="Generate plaza QR code">
                              {getPlazaQrCodeMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <QrCode className="w-3.5 h-3.5" />}
                            </Button>
                          )}
                          <Button size="sm" variant="ghost"
                            className="h-7 w-7 p-0 text-red-500 hover:text-red-700 hover:bg-red-50"
                            onClick={() => handleDelete(device.id)}
                            disabled={deleteMutation.isPending}
                            title="Delete device">
                            {deleteMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                          </Button>
                        </>
                      )}
                      {!isAdmin && (
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => handleReboot(device.id)}
                          title="Reboot device">
                          <RefreshCw className="w-3.5 h-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* Expanded Detail */}
                  {selectedDevice?.id === device.id && (
                    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                      className="mt-4 pt-4 border-t border-border space-y-4">
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        {[
                          { label: "Serial Number", value: device.serial, icon: Cpu },
                          { label: "Firmware", value: `v${device.firmware}${needsUpdate ? ` → v${device.latestFirmware}` : " (latest)"}`, icon: Download },
                          { label: "Uptime", value: device.uptime, icon: Activity },
                          { label: "Type", value: TYPE_LABELS[device.type], icon: Settings },
                        ].map(item => (
                          <div key={item.label} className="bg-muted rounded-xl p-3">
                            <div className="flex items-center gap-1.5 mb-1">
                              <item.icon className="w-3.5 h-3.5 text-muted-foreground" />
                              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">{item.label}</span>
                            </div>
                            <div className="text-sm font-medium">{item.value}</div>
                          </div>
                        ))}
                      </div>

                      {/* Admin action buttons in expanded panel */}
                      {isAdmin && (
                        <div className="flex gap-2 flex-wrap" onClick={e => e.stopPropagation()}>
                          <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5 text-emerald-600 border-emerald-200 hover:bg-emerald-50"
                            onClick={(e) => handleSimulateHeartbeat(device, e)}
                            disabled={isSimulating}>
                            {isSimulating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Radio className="w-3.5 h-3.5" />}
                            {isSimulating ? "Sending..." : "Simulate Heartbeat"}
                          </Button>
                          {device.type === "nfc_reader" && (
                            <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5 text-blue-600 border-blue-200 hover:bg-blue-50"
                              onClick={(e) => handleGenerateQrCode(device, e)}
                              disabled={getPlazaQrCodeMutation.isPending}>
                              {getPlazaQrCodeMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <QrCode className="w-3.5 h-3.5" />}
                              Generate Plaza QR
                            </Button>
                          )}
                          {device.type === "nfc_reader" && (
                            <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5 text-violet-600 border-violet-200 hover:bg-violet-50"
                              onClick={(e) => { e.stopPropagation(); setRotatingSerial(device.serial); rotateQrCodeMutation.mutate({ serial: device.serial }); }}
                              disabled={rotatingSerial === device.serial}>
                              {rotatingSerial === device.serial ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                              Rotate QR (24h)
                            </Button>
                          )}
                          <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5 text-slate-600 border-slate-200 hover:bg-slate-50"
                            onClick={(e) => { e.stopPropagation(); setHistoryDeviceId(parseInt(device.id)); }}>
                            <History className="w-3.5 h-3.5" />
                            Alert History
                          </Button>
                          {device.type === "nfc_reader" && (
                            <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5 text-indigo-600 border-indigo-200 hover:bg-indigo-50"
                              onClick={(e) => handlePrintPlazaQrSheet(device.plaza, e)}
                              disabled={printingPlaza === device.plaza}>
                              {printingPlaza === device.plaza ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Printer className="w-3.5 h-3.5" />}
                              Print All Plaza QRs
                            </Button>
                          )}
                          {device.alerts > 0 && (
                            <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5 text-orange-600 border-orange-200 hover:bg-orange-50"
                              onClick={(e) => handleResolveAlert(device, e)}>
                              <ShieldCheck className="w-3.5 h-3.5" />
                              Resolve {device.alerts} Alert{device.alerts > 1 ? "s" : ""}
                            </Button>
                          )}
                          {needsUpdate && (
                            <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5 text-teal-600 border-teal-200 hover:bg-teal-50"
                              onClick={(e) => { e.stopPropagation(); reportFirmwareVersionMutation.mutate({ serial: device.serial, version: device.latestFirmware }); }}
                              disabled={reportFirmwareVersionMutation.isPending}>
                              {reportFirmwareVersionMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
                              Mark as Updated (v{device.latestFirmware})
                            </Button>
                          )}
                          <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5"
                            onClick={() => handleReboot(device.id)}>
                            <RefreshCw className="w-3.5 h-3.5" />
                            Reboot
                          </Button>
                        </div>
                      )}
                    </motion.div>
                  )}
                </motion.div>
              );
            })}
          </div>

          {filtered.length === 0 && (
            <div className="p-12 text-center text-muted-foreground">
              <Cpu className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No devices match your search</p>
            </div>
          )}
        </div>
      </div>

      {/* Plaza QR Code Modal */}
      <AnimatePresence>
        {qrModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
            onClick={() => setQrModal(null)}>
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-white rounded-2xl shadow-2xl p-6 max-w-sm w-full"
              onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="font-bold text-base">Plaza Station QR Code</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">{qrModal.name}</p>
                </div>
                <button onClick={() => setQrModal(null)} className="p-1.5 rounded-lg hover:bg-muted transition-colors">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="flex flex-col items-center gap-4 py-4">
                <div className="p-4 bg-white border-2 border-border rounded-xl shadow-sm">
                  <QRCodeSVG
                    id="plaza-qr-svg"
                    value={qrModal.qrUri}
                    size={200}
                    level="H"
                    includeMargin={false}
                    imageSettings={{
                      src: "/favicon.ico",
                      width: 32,
                      height: 32,
                      excavate: true,
                    }}
                  />
                </div>

                {qrModal.expiresAt && (
                  <div className={cn(
                    "w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium",
                    qrCountdown === "Expired"
                      ? "bg-red-50 border border-red-200 text-red-700"
                      : "bg-amber-50 border border-amber-200 text-amber-700"
                  )}>
                    <Clock className="w-3.5 h-3.5 shrink-0" />
                    {qrCountdown === "Expired"
                      ? "QR code has expired — rotate to refresh"
                      : qrCountdown
                        ? `Expires in ${qrCountdown}`
                        : `Expires ${new Date(qrModal.expiresAt).toLocaleString()}`
                    }
                  </div>
                )}
                <div className="w-full space-y-1.5 text-sm">
                  {[
                    { label: "Serial", value: qrModal.serial },
                    { label: "Plaza", value: qrModal.plaza },
                    { label: "Lane", value: qrModal.lane },
                    { label: "Generated", value: new Date(qrModal.generatedAt).toLocaleString() },
                    ...(qrModal.ttlHours ? [{ label: "TTL", value: `${qrModal.ttlHours}h` }] : []),
                  ].map(item => (
                    <div key={item.label} className="flex justify-between items-center py-1 border-b border-border/50 last:border-0">
                      <span className="text-muted-foreground text-xs">{item.label}</span>
                      <span className="font-medium text-xs">{item.value}</span>
                    </div>
                  ))}
                </div>

                <div className="w-full bg-muted rounded-lg p-2">
                  <p className="text-[10px] text-muted-foreground font-mono break-all leading-relaxed">
                    {qrModal.qrUri.length > 80 ? qrModal.qrUri.slice(0, 80) + "…" : qrModal.qrUri}
                  </p>
                </div>
              </div>

              <div className="flex gap-2 mt-2">
                <Button className="flex-1 h-9 text-sm gap-1.5" onClick={handleDownloadQr}>
                  <Download className="w-4 h-4" />
                  Download SVG
                </Button>
                <Button variant="outline" className="flex-1 h-9 text-sm" onClick={() => {
                  navigator.clipboard.writeText(qrModal.qrUri);
                  toast.success("QR URI copied to clipboard");
                }}>
                  Copy URI
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Alert History Modal */}
      <AnimatePresence>
        {historyDeviceId !== null && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
            onClick={() => setHistoryDeviceId(null)}>
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-white rounded-2xl shadow-2xl p-6 max-w-lg w-full max-h-[80vh] flex flex-col"
              onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <div className="w-9 h-9 rounded-xl bg-slate-100 flex items-center justify-center">
                    <History className="w-5 h-5 text-slate-600" />
                  </div>
                  <div>
                    <h3 className="font-bold text-base">Alert Resolution History</h3>
                    <p className="text-xs text-muted-foreground">Device ID #{historyDeviceId}</p>
                  </div>
                </div>
                <button onClick={() => setHistoryDeviceId(null)} className="p-1.5 rounded-lg hover:bg-muted transition-colors">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto">
                {alertHistoryQuery.isLoading && (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                  </div>
                )}
                {!alertHistoryQuery.isLoading && (alertHistoryQuery.data?.length ?? 0) === 0 && (
                  <div className="text-center py-12">
                    <ShieldCheck className="w-10 h-10 mx-auto mb-3 text-muted-foreground/30" />
                    <p className="text-sm text-muted-foreground">No alert resolutions recorded yet</p>
                    <p className="text-xs text-muted-foreground mt-1">History is written each time alerts are resolved</p>
                  </div>
                )}
                {(alertHistoryQuery.data ?? []).map((entry) => (
                  <div key={entry.id} className="flex gap-3 py-3 border-b border-border last:border-0">
                    <div className="w-8 h-8 rounded-full bg-orange-100 flex items-center justify-center shrink-0 mt-0.5">
                      <ShieldCheck className="w-4 h-4 text-orange-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-foreground">
                          {entry.alertsCleared} alert{entry.alertsCleared !== 1 ? "s" : ""} cleared
                        </span>
                        <span className="text-[10px] text-muted-foreground shrink-0">
                          {new Date(entry.resolvedAt).toLocaleString()}
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        By <span className="font-medium text-foreground">{entry.resolvedByName ?? "Admin"}</span>
                        {" · "}{entry.plaza}
                      </div>
                      {entry.note && (
                        <div className="mt-1.5 text-xs bg-muted rounded-lg px-2.5 py-1.5 text-foreground">
                          "{entry.note}"
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <div className="pt-4 border-t border-border mt-2">
                <Button variant="outline" className="w-full h-9 text-sm" onClick={() => setHistoryDeviceId(null)}>
                  Close
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      {/* Resolve Alert Modal */}
      <AnimatePresence>
        {resolveModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
            onClick={() => setResolveModal(null)}>
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-white rounded-2xl shadow-2xl p-6 max-w-sm w-full"
              onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <div className="w-9 h-9 rounded-xl bg-orange-100 flex items-center justify-center">
                    <ShieldCheck className="w-5 h-5 text-orange-600" />
                  </div>
                  <div>
                    <h3 className="font-bold text-base">Resolve Alerts</h3>
                    <p className="text-xs text-muted-foreground">{resolveModal.deviceName}</p>
                  </div>
                </div>
                <button onClick={() => setResolveModal(null)} className="p-1.5 rounded-lg hover:bg-muted transition-colors">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="mb-4 p-3 bg-orange-50 border border-orange-200 rounded-xl">
                <p className="text-sm text-orange-800">
                  This will clear <strong>{resolveModal.alertCount} active alert{resolveModal.alertCount !== 1 ? "s" : ""}</strong> on this device. Add an optional resolution note for audit purposes.
                </p>
              </div>

              <div className="mb-4">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
                  Resolution Note (optional)
                </label>
                <textarea
                  value={resolveModal.note}
                  onChange={e => setResolveModal(prev => prev ? { ...prev, note: e.target.value } : null)}
                  placeholder="e.g. Replaced faulty NFC antenna, device back online..."
                  className="w-full h-20 text-sm border border-border rounded-lg px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-primary/30"
                  maxLength={512}
                />
                <p className="text-[10px] text-muted-foreground mt-1 text-right">{resolveModal.note.length}/512</p>
              </div>

              <div className="flex gap-2">
                <Button
                  className="flex-1 h-9 text-sm gap-1.5 bg-orange-500 hover:bg-orange-600"
                  onClick={() => resolveAlertMutation.mutate({
                    id: parseInt(resolveModal.deviceId),
                    note: resolveModal.note || undefined,
                  })}
                  disabled={resolveAlertMutation.isPending}>
                  {resolveAlertMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                  {resolveAlertMutation.isPending ? "Resolving..." : "Resolve Alerts"}
                </Button>
                <Button variant="outline" className="flex-1 h-9 text-sm" onClick={() => setResolveModal(null)}>
                  Cancel
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </PortalLayout>
  );
}
