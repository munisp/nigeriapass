/**
 * NigerianPass Toll Plaza Map
 * Design: Premium Civic — Navy authority base, Sora + Nunito Sans
 *
 * Features:
 *  - Google Maps with AdvancedMarkerElement for each toll plaza
 *  - Color-coded markers by plaza status (active / maintenance / offline)
 *  - Real-time device status overlay: live dots on each plaza marker
 *    driven by trpc.devices.plazaSummary + useDeviceHeartbeat stream
 *  - Click-through side panel with plaza details, live device counts, and transaction volume
 *  - Traffic layer toggle
 *  - Search/filter by state or road
 *  - Mini stats bar (total plazas, active, daily transactions, revenue)
 */
import { useRef, useState, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  MapPin, Zap, AlertTriangle, WifiOff, Search, X, ChevronRight,
  TrendingUp, Activity, DollarSign, Layers, RefreshCw, Navigation,
  Cpu, Wifi, Radio,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { MapView } from "@/components/Map";
import PortalLayout from "@/components/PortalLayout";
import { trpc } from "@/lib/trpc";
import { useDeviceHeartbeat } from "@/hooks/useDeviceHeartbeat";

// ── Types ─────────────────────────────────────────────────────────────────────
type PlazaStatus = "active" | "maintenance" | "offline";

interface TollPlaza {
  id: string;
  name: string;
  road: string;
  state: string;
  lat: number;
  lng: number;
  status: PlazaStatus;
  lanes: number;
  dailyTransactions: number;
  dailyRevenue: number; // NGN
  avgLatencyMs: number;
  tollClass: string;
  lastSeen: string;
  operator: string;
  /** Canonical DB plaza name for device matching */
  dbPlazaName?: string;
}

interface PlazaDeviceSummary {
  plaza: string;
  total: number;
  online: number;
  warning: number;
  offline: number;
  maintenance: number;
}

// ── Nigerian toll plaza data ───────────────────────────────────────────────────
const TOLL_PLAZAS: TollPlaza[] = [
  {
    id: "PLZ-001", name: "Sagamu Interchange", road: "Lagos-Ibadan Expressway (A1)",
    state: "Ogun", lat: 6.8388, lng: 3.6481, status: "active",
    lanes: 12, dailyTransactions: 28_400, dailyRevenue: 9_940_000,
    avgLatencyMs: 142, tollClass: "Class I–IV", lastSeen: "2 min ago", operator: "FERMA",
    dbPlazaName: "Lagos–Ibadan Expressway Toll Plaza",
  },
  {
    id: "PLZ-002", name: "Berger Toll Plaza", road: "Lagos-Ibadan Expressway (A1)",
    state: "Lagos", lat: 6.6194, lng: 3.3792, status: "active",
    lanes: 16, dailyTransactions: 41_200, dailyRevenue: 14_420_000,
    avgLatencyMs: 138, tollClass: "Class I–V", lastSeen: "1 min ago", operator: "FERMA",
    dbPlazaName: "Lekki–Epe Expressway Toll Plaza",
  },
  {
    id: "PLZ-003", name: "Shagamu-Ore Toll", road: "Benin-Lagos Expressway (A121)",
    state: "Ondo", lat: 6.9973, lng: 4.7937, status: "active",
    lanes: 8, dailyTransactions: 14_800, dailyRevenue: 5_180_000,
    avgLatencyMs: 155, tollClass: "Class I–III", lastSeen: "3 min ago", operator: "FERMA",
    dbPlazaName: "Benin–Ore–Sagamu Expressway Toll Plaza",
  },
  {
    id: "PLZ-004", name: "Abuja-Kaduna Toll", road: "Abuja-Kaduna Expressway (A2)",
    state: "Kaduna", lat: 10.1897, lng: 7.5449, status: "active",
    lanes: 10, dailyTransactions: 19_600, dailyRevenue: 6_860_000,
    avgLatencyMs: 149, tollClass: "Class I–IV", lastSeen: "4 min ago", operator: "Julius Berger",
    dbPlazaName: "Abuja–Keffi Expressway Toll Plaza",
  },
  {
    id: "PLZ-005", name: "Kara Bridge Toll", road: "Lagos-Ibadan Expressway (A1)",
    state: "Lagos", lat: 6.6553, lng: 3.4072, status: "maintenance",
    lanes: 4, dailyTransactions: 3_200, dailyRevenue: 1_120_000,
    avgLatencyMs: 210, tollClass: "Class I–II", lastSeen: "18 min ago", operator: "FERMA",
    dbPlazaName: "Third Mainland Bridge Toll Plaza",
  },
  {
    id: "PLZ-006", name: "Enugu-Onitsha Toll", road: "Enugu-Onitsha Expressway (A232)",
    state: "Anambra", lat: 6.1667, lng: 6.7833, status: "active",
    lanes: 8, dailyTransactions: 12_400, dailyRevenue: 4_340_000,
    avgLatencyMs: 161, tollClass: "Class I–III", lastSeen: "5 min ago", operator: "Julius Berger",
  },
  {
    id: "PLZ-007", name: "Ore Toll Plaza", road: "Benin-Lagos Expressway (A121)",
    state: "Ondo", lat: 6.7498, lng: 4.8619, status: "offline",
    lanes: 6, dailyTransactions: 0, dailyRevenue: 0,
    avgLatencyMs: 0, tollClass: "Class I–III", lastSeen: "2 hrs ago", operator: "FERMA",
  },
  {
    id: "PLZ-008", name: "Ilorin Toll Gate", road: "Abuja-Lagos Expressway (A1)",
    state: "Kwara", lat: 8.4966, lng: 4.5421, status: "active",
    lanes: 8, dailyTransactions: 11_200, dailyRevenue: 3_920_000,
    avgLatencyMs: 153, tollClass: "Class I–IV", lastSeen: "6 min ago", operator: "FERMA",
  },
  {
    id: "PLZ-009", name: "Benin-Asaba Toll", road: "East-West Road (A232)",
    state: "Delta", lat: 6.1986, lng: 6.5244, status: "active",
    lanes: 6, dailyTransactions: 9_800, dailyRevenue: 3_430_000,
    avgLatencyMs: 168, tollClass: "Class I–III", lastSeen: "7 min ago", operator: "Julius Berger",
  },
  {
    id: "PLZ-010", name: "Kano-Zaria Toll", road: "Kano-Kaduna Expressway (A2)",
    state: "Kano", lat: 11.9973, lng: 8.5197, status: "maintenance",
    lanes: 4, dailyTransactions: 2_100, dailyRevenue: 735_000,
    avgLatencyMs: 198, tollClass: "Class I–II", lastSeen: "22 min ago", operator: "FERMA",
    dbPlazaName: "Kano–Zaria Expressway Toll Plaza",
  },
  {
    id: "PLZ-011", name: "Owerri-Port Harcourt Toll", road: "Port Harcourt-Owerri Road",
    state: "Rivers", lat: 5.0527, lng: 6.7794, status: "active",
    lanes: 8, dailyTransactions: 13_600, dailyRevenue: 4_760_000,
    avgLatencyMs: 145, tollClass: "Class I–IV", lastSeen: "3 min ago", operator: "FERMA",
  },
  {
    id: "PLZ-012", name: "Ibadan-Ife Toll", road: "Ibadan-Ife Expressway (A121)",
    state: "Osun", lat: 7.5629, lng: 4.5200, status: "active",
    lanes: 6, dailyTransactions: 8_900, dailyRevenue: 3_115_000,
    avgLatencyMs: 157, tollClass: "Class I–III", lastSeen: "8 min ago", operator: "FERMA",
  },
];

const STATUS_CONFIG: Record<PlazaStatus, { label: string; color: string; dot: string; icon: React.ElementType }> = {
  active: { label: "Active", color: "text-emerald-700 bg-emerald-50 border-emerald-200", dot: "bg-emerald-500", icon: Zap },
  maintenance: { label: "Maintenance", color: "text-amber-700 bg-amber-50 border-amber-200", dot: "bg-amber-500", icon: AlertTriangle },
  offline: { label: "Offline", color: "text-red-700 bg-red-50 border-red-200", dot: "bg-red-500", icon: WifiOff },
};

const MARKER_COLORS: Record<PlazaStatus, string> = {
  active: "#10b981",
  maintenance: "#f59e0b",
  offline: "#ef4444",
};

function formatNGN(amount: number): string {
  if (amount >= 1_000_000) return `₦${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `₦${(amount / 1_000).toFixed(0)}K`;
  return `₦${amount.toLocaleString()}`;
}

// ── Device Status Pill ────────────────────────────────────────────────────────
function DeviceStatusPill({ summary }: { summary: PlazaDeviceSummary }) {
  if (summary.total === 0) return null;
  const allOnline = summary.online === summary.total;
  const hasWarning = summary.warning > 0;
  const hasOffline = summary.offline > 0;

  return (
    <div className="flex items-center gap-1.5 mt-2 flex-wrap">
      <div className="flex items-center gap-1 text-[10px] font-medium">
        <Cpu className="w-3 h-3 text-muted-foreground" />
        <span className="text-muted-foreground">{summary.total} devices</span>
      </div>
      {summary.online > 0 && (
        <span className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 font-medium">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
          {summary.online} online
        </span>
      )}
      {summary.warning > 0 && (
        <span className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-amber-700 font-medium">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
          {summary.warning} warn
        </span>
      )}
      {summary.offline > 0 && (
        <span className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-red-50 border border-red-200 text-red-700 font-medium">
          <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
          {summary.offline} offline
        </span>
      )}
      {allOnline && !hasWarning && !hasOffline && (
        <span className="text-[10px] text-emerald-600 font-medium">All healthy</span>
      )}
    </div>
  );
}

// ── Plaza detail panel ────────────────────────────────────────────────────────
function PlazaPanel({
  plaza, onClose, deviceSummary, liveHeartbeatCount,
}: {
  plaza: TollPlaza;
  onClose: () => void;
  deviceSummary?: PlazaDeviceSummary;
  liveHeartbeatCount: number;
}) {
  const cfg = STATUS_CONFIG[plaza.status];
  const Icon = cfg.icon;
  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }}
      transition={{ duration: 0.22 }}
      className="absolute top-4 right-4 z-20 w-80 bg-white rounded-2xl shadow-xl border border-border overflow-hidden"
    >
      {/* Header */}
      <div className="p-4 border-b border-border">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <span className={cn("text-xs px-2 py-0.5 rounded-full border font-medium flex items-center gap-1", cfg.color)}>
                <Icon className="w-3 h-3" />
                {cfg.label}
              </span>
            </div>
            <h3 className="font-bold text-foreground leading-tight" style={{ fontFamily: "Sora, sans-serif" }}>
              {plaza.name}
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">{plaza.road}</p>
            <p className="text-xs text-muted-foreground">{plaza.state} State · {plaza.operator}</p>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-muted text-muted-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Stats grid */}
      <div className="p-4 grid grid-cols-2 gap-3">
        <div className="bg-muted/50 rounded-xl p-3">
          <div className="flex items-center gap-1.5 mb-1">
            <Activity className="w-3.5 h-3.5 text-blue-500" />
            <span className="text-xs text-muted-foreground">Daily Transactions</span>
          </div>
          <div className="text-lg font-bold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
            {plaza.dailyTransactions.toLocaleString()}
          </div>
        </div>
        <div className="bg-muted/50 rounded-xl p-3">
          <div className="flex items-center gap-1.5 mb-1">
            <DollarSign className="w-3.5 h-3.5 text-emerald-500" />
            <span className="text-xs text-muted-foreground">Daily Revenue</span>
          </div>
          <div className="text-lg font-bold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
            {formatNGN(plaza.dailyRevenue)}
          </div>
        </div>
        <div className="bg-muted/50 rounded-xl p-3">
          <div className="flex items-center gap-1.5 mb-1">
            <Zap className="w-3.5 h-3.5 text-amber-500" />
            <span className="text-xs text-muted-foreground">Avg Latency</span>
          </div>
          <div className="text-lg font-bold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
            {plaza.avgLatencyMs > 0 ? `${plaza.avgLatencyMs}ms` : "—"}
          </div>
        </div>
        <div className="bg-muted/50 rounded-xl p-3">
          <div className="flex items-center gap-1.5 mb-1">
            <Navigation className="w-3.5 h-3.5 text-purple-500" />
            <span className="text-xs text-muted-foreground">Active Lanes</span>
          </div>
          <div className="text-lg font-bold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
            {plaza.status === "offline" ? "0" : plaza.lanes}
          </div>
        </div>
      </div>

      {/* Transaction volume bar */}
      <div className="px-4">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs text-muted-foreground">Throughput vs. capacity</span>
          <span className="text-xs font-medium text-foreground">
            {plaza.dailyTransactions > 0
              ? `${Math.round((plaza.dailyTransactions / (plaza.lanes * 3000)) * 100)}%`
              : "0%"}
          </span>
        </div>
        <div className="h-2 bg-muted rounded-full overflow-hidden">
          <motion.div
            className={cn("h-full rounded-full",
              plaza.status === "active" ? "bg-emerald-500" :
              plaza.status === "maintenance" ? "bg-amber-500" : "bg-red-400")}
            initial={{ width: 0 }}
            animate={{ width: `${Math.min(100, Math.round((plaza.dailyTransactions / (plaza.lanes * 3000)) * 100))}%` }}
            transition={{ duration: 0.6, ease: "easeOut" }}
          />
        </div>
      </div>

      {/* Live Device Status Section */}
      {deviceSummary && deviceSummary.total > 0 && (
        <div className="px-4 pt-3 pb-2">
          <div className="flex items-center gap-1.5 mb-2">
            <Radio className="w-3.5 h-3.5 text-primary" />
            <span className="text-xs font-semibold text-foreground">Live Device Status</span>
            {liveHeartbeatCount > 0 && (
              <span className="ml-auto flex items-center gap-1 text-[10px] text-emerald-600">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                {liveHeartbeatCount} live
              </span>
            )}
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {[
              { label: "Online", value: deviceSummary.online, color: "bg-emerald-50 text-emerald-700 border-emerald-200" },
              { label: "Warning", value: deviceSummary.warning, color: "bg-amber-50 text-amber-700 border-amber-200" },
              { label: "Offline", value: deviceSummary.offline, color: "bg-red-50 text-red-700 border-red-200" },
              { label: "Maint.", value: deviceSummary.maintenance, color: "bg-blue-50 text-blue-700 border-blue-200" },
            ].map(item => (
              <div key={item.label} className={cn("rounded-lg border p-2 text-center", item.color)}>
                <div className="text-base font-bold">{item.value}</div>
                <div className="text-[9px] font-medium">{item.label}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="px-4 pb-4 pt-2 flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          <span className="font-medium">Toll class:</span> {plaza.tollClass}
        </div>
        <div className="text-xs text-muted-foreground flex items-center gap-1">
          <span className={cn("w-1.5 h-1.5 rounded-full", STATUS_CONFIG[plaza.status].dot)} />
          Last seen {plaza.lastSeen}
        </div>
      </div>
    </motion.div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function TollMap() {
  const mapRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<google.maps.marker.AdvancedMarkerElement[]>([]);
  const markerPinsRef = useRef<Map<string, HTMLElement>>(new Map());
  const [selectedPlaza, setSelectedPlaza] = useState<TollPlaza | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterStatus, setFilterStatus] = useState<PlazaStatus | "all">("all");
  const [trafficLayer, setTrafficLayer] = useState(false);
  const trafficLayerRef = useRef<google.maps.TrafficLayer | null>(null);

  // Real-time device data
  const plazaSummaryQuery = trpc.devices.plazaSummary.useQuery(undefined, {
    refetchInterval: 15_000, // refresh every 15 s
  });
  const { devices: liveDevices, connected: wsConnected, lastUpdate } = useDeviceHeartbeat();

  // Build a map of dbPlazaName → PlazaDeviceSummary from tRPC
  const deviceSummaryMap = new Map<string, PlazaDeviceSummary>();
  for (const row of (plazaSummaryQuery.data ?? [])) {
    deviceSummaryMap.set(row.plaza, row as PlazaDeviceSummary);
  }

  // Count live heartbeats per plaza (by matching serial prefix or plaza field from WS)
  const liveCountByPlaza = new Map<string, number>();
  for (const hb of liveDevices) {
    // hb.serial like "NP-NFC-LIE-001" — extract plaza from device list query if available
    // We count all live devices and attribute to plazas via the summary map
    const matchingPlaza = Array.from(deviceSummaryMap.keys()).find(p =>
      hb.serial?.includes(p.slice(0, 3).toUpperCase()) ||
      hb.device_id?.toString().includes(p.slice(0, 3))
    );
    if (matchingPlaza) {
      liveCountByPlaza.set(matchingPlaza, (liveCountByPlaza.get(matchingPlaza) ?? 0) + 1);
    }
  }

  const filteredPlazas = TOLL_PLAZAS.filter(p => {
    const matchSearch = !searchQuery ||
      p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.state.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.road.toLowerCase().includes(searchQuery.toLowerCase());
    const matchStatus = filterStatus === "all" || p.status === filterStatus;
    return matchSearch && matchStatus;
  });

  // ── Summary stats ─────────────────────────────────────────────────────────
  const stats = {
    total: TOLL_PLAZAS.length,
    active: TOLL_PLAZAS.filter(p => p.status === "active").length,
    dailyTx: TOLL_PLAZAS.reduce((s, p) => s + p.dailyTransactions, 0),
    dailyRev: TOLL_PLAZAS.reduce((s, p) => s + p.dailyRevenue, 0),
  };

  // ── Build markers on map ready ────────────────────────────────────────────
  const handleMapReady = useCallback((map: google.maps.Map) => {
    mapRef.current = map;

    TOLL_PLAZAS.forEach(plaza => {
      const color = MARKER_COLORS[plaza.status];
      const pin = document.createElement("div");
      pin.style.position = "relative";
      pin.innerHTML = `
        <div style="
          width:32px;height:32px;border-radius:50% 50% 50% 0;
          background:${color};border:2px solid white;
          box-shadow:0 2px 8px rgba(0,0,0,0.3);
          transform:rotate(-45deg);
          display:flex;align-items:center;justify-content:center;
          cursor:pointer;
        ">
          <div style="transform:rotate(45deg);color:white;font-size:12px;font-weight:bold;">⬡</div>
        </div>
        <div id="device-dot-${plaza.id}" style="
          position:absolute;top:-4px;right:-4px;
          width:12px;height:12px;border-radius:50%;
          background:#6b7280;border:2px solid white;
          display:none;
        "></div>
      `;

      markerPinsRef.current.set(plaza.id, pin);

      const marker = new google.maps.marker.AdvancedMarkerElement({
        map,
        position: { lat: plaza.lat, lng: plaza.lng },
        title: plaza.name,
        content: pin,
      });

      marker.addListener("click", () => {
        setSelectedPlaza(plaza);
        map.panTo({ lat: plaza.lat, lng: plaza.lng });
        map.setZoom(12);
      });

      markersRef.current.push(marker);
    });
  }, []);

  // ── Update device status dots on markers when plazaSummary changes ────────
  useEffect(() => {
    if (!mapRef.current) return;
    for (const plaza of TOLL_PLAZAS) {
      const dbName = plaza.dbPlazaName;
      if (!dbName) continue;
      const summary = deviceSummaryMap.get(dbName);
      const dot = document.getElementById(`device-dot-${plaza.id}`);
      if (!dot || !summary || summary.total === 0) continue;

      dot.style.display = "block";
      // Color: red if any offline, amber if any warning, green if all online
      if (summary.offline > 0) {
        dot.style.background = "#ef4444";
      } else if (summary.warning > 0) {
        dot.style.background = "#f59e0b";
      } else {
        dot.style.background = "#10b981";
      }
      // Pulse animation for warning/offline
      if (summary.offline > 0 || summary.warning > 0) {
        dot.style.animation = "pulse 2s infinite";
      } else {
        dot.style.animation = "";
      }
    }
  }, [plazaSummaryQuery.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Traffic layer toggle ──────────────────────────────────────────────────
  const toggleTraffic = () => {
    if (!mapRef.current) return;
    if (trafficLayer) {
      trafficLayerRef.current?.setMap(null);
      setTrafficLayer(false);
    } else {
      if (!trafficLayerRef.current) {
        trafficLayerRef.current = new google.maps.TrafficLayer();
      }
      trafficLayerRef.current.setMap(mapRef.current);
      setTrafficLayer(true);
    }
  };

  // ── Fly to plaza ──────────────────────────────────────────────────────────
  const flyTo = (plaza: TollPlaza) => {
    if (!mapRef.current) return;
    mapRef.current.panTo({ lat: plaza.lat, lng: plaza.lng });
    mapRef.current.setZoom(13);
    setSelectedPlaza(plaza);
  };

  return (
    <PortalLayout title="Toll Plaza Map" subtitle="Live view of all NigerianPass toll plazas across Nigeria">
      <div className="flex flex-col h-[calc(100vh-8rem)]">

        {/* ── Stats bar ──────────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-4 shrink-0">
          {[
            { icon: MapPin, label: "Total Plazas", value: stats.total, color: "text-blue-600 bg-blue-50" },
            { icon: Zap, label: "Active", value: stats.active, color: "text-emerald-600 bg-emerald-50" },
            { icon: Activity, label: "Daily Transactions", value: stats.dailyTx.toLocaleString(), color: "text-purple-600 bg-purple-50" },
            { icon: TrendingUp, label: "Daily Revenue", value: formatNGN(stats.dailyRev), color: "text-amber-600 bg-amber-50" },
          ].map(s => (
            <div key={s.label} className="bg-white rounded-xl border border-border p-3 flex items-center gap-3">
              <div className={cn("w-9 h-9 rounded-lg flex items-center justify-center shrink-0", s.color)}>
                <s.icon className="w-4 h-4" />
              </div>
              <div>
                <div className="text-xs text-muted-foreground">{s.label}</div>
                <div className="text-lg font-bold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>{s.value}</div>
              </div>
            </div>
          ))}
        </div>

        {/* ── Main content: sidebar + map ─────────────────────────────────── */}
        <div className="flex flex-1 gap-4 px-4 pb-4 min-h-0">

          {/* Sidebar */}
          <div className="w-72 shrink-0 flex flex-col gap-3">
            {/* Search */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search plazas, roads, states…"
                className="pl-9 h-9 text-sm"
              />
              {searchQuery && (
                <button onClick={() => setSearchQuery("")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Status filter */}
            <div className="flex gap-1.5">
              {(["all", "active", "maintenance", "offline"] as const).map(s => (
                <button
                  key={s}
                  onClick={() => setFilterStatus(s)}
                  className={cn(
                    "flex-1 py-1 text-xs font-medium rounded-lg border transition-all capitalize",
                    filterStatus === s
                      ? s === "all" ? "bg-primary text-primary-foreground border-primary"
                        : s === "active" ? "bg-emerald-500 text-white border-emerald-500"
                        : s === "maintenance" ? "bg-amber-500 text-white border-amber-500"
                        : "bg-red-500 text-white border-red-500"
                      : "bg-white text-muted-foreground border-border hover:border-primary/50"
                  )}
                >
                  {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1, 5)}
                </button>
              ))}
            </div>

            {/* Plaza list */}
            <div className="flex-1 overflow-y-auto space-y-1.5 pr-1">
              {filteredPlazas.length === 0 && (
                <div className="text-center py-8 text-muted-foreground text-sm">No plazas match your filter</div>
              )}
              {filteredPlazas.map(plaza => {
                const cfg = STATUS_CONFIG[plaza.status];
                const summary = plaza.dbPlazaName ? deviceSummaryMap.get(plaza.dbPlazaName) : undefined;
                return (
                  <button
                    key={plaza.id}
                    onClick={() => flyTo(plaza)}
                    className={cn(
                      "w-full text-left p-3 rounded-xl border transition-all hover:shadow-sm",
                      selectedPlaza?.id === plaza.id
                        ? "border-primary bg-primary/5 shadow-sm"
                        : "border-border bg-white hover:border-primary/40"
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 mb-0.5">
                          <span className={cn("w-2 h-2 rounded-full shrink-0", cfg.dot)} />
                          <span className="text-sm font-semibold text-foreground truncate" style={{ fontFamily: "Sora, sans-serif" }}>
                            {plaza.name}
                          </span>
                        </div>
                        <div className="text-xs text-muted-foreground truncate">{plaza.state} · {plaza.road.split(" (")[0]}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {plaza.dailyTransactions.toLocaleString()} tx/day · {formatNGN(plaza.dailyRevenue)}
                        </div>
                        {/* Live device status mini-pills */}
                        {summary && summary.total > 0 && (
                          <div className="flex items-center gap-1 mt-1.5 flex-wrap">
                            <Wifi className="w-3 h-3 text-muted-foreground" />
                            {summary.online > 0 && (
                              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 font-medium flex items-center gap-0.5">
                                <span className="w-1 h-1 rounded-full bg-emerald-500 animate-pulse" />
                                {summary.online}
                              </span>
                            )}
                            {summary.warning > 0 && (
                              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-amber-700 font-medium">
                                ⚠ {summary.warning}
                              </span>
                            )}
                            {summary.offline > 0 && (
                              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-red-50 border border-red-200 text-red-700 font-medium">
                                ✕ {summary.offline}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                      <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Traffic toggle */}
            <Button
              variant="outline"
              size="sm"
              onClick={toggleTraffic}
              className={cn("gap-2 w-full", trafficLayer && "bg-blue-50 border-blue-300 text-blue-700")}
            >
              <Layers className="w-3.5 h-3.5" />
              {trafficLayer ? "Hide Traffic Layer" : "Show Traffic Layer"}
            </Button>
          </div>

          {/* Map container */}
          <div className="flex-1 relative rounded-2xl overflow-hidden border border-border shadow-sm">
            <MapView
              className="w-full h-full"
              initialCenter={{ lat: 8.5, lng: 5.5 }}
              initialZoom={6}
              onMapReady={handleMapReady}
            />

            {/* Plaza detail panel overlay */}
            <AnimatePresence>
              {selectedPlaza && (
                <PlazaPanel
                  plaza={selectedPlaza}
                  onClose={() => setSelectedPlaza(null)}
                  deviceSummary={selectedPlaza.dbPlazaName ? deviceSummaryMap.get(selectedPlaza.dbPlazaName) : undefined}
                  liveHeartbeatCount={selectedPlaza.dbPlazaName ? (liveCountByPlaza.get(selectedPlaza.dbPlazaName) ?? 0) : 0}
                />
              )}
            </AnimatePresence>

            {/* Legend */}
            <div className="absolute bottom-4 left-4 bg-white/95 backdrop-blur-sm rounded-xl border border-border p-3 shadow-sm">
              <div className="text-xs font-semibold text-foreground mb-2">Plaza Status</div>
              <div className="space-y-1.5">
                {(["active", "maintenance", "offline"] as PlazaStatus[]).map(s => (
                  <div key={s} className="flex items-center gap-2">
                    <span className={cn("w-2.5 h-2.5 rounded-full", STATUS_CONFIG[s].dot)} />
                    <span className="text-xs text-muted-foreground capitalize">{s}</span>
                    <span className="text-xs text-muted-foreground ml-auto">
                      {TOLL_PLAZAS.filter(p => p.status === s).length}
                    </span>
                  </div>
                ))}
                <div className="border-t border-border pt-1.5 mt-1.5">
                  <div className="text-xs font-semibold text-foreground mb-1">Device Dot</div>
                  {[
                    { color: "bg-emerald-500", label: "All online" },
                    { color: "bg-amber-500", label: "Warning" },
                    { color: "bg-red-500", label: "Offline devices" },
                  ].map(item => (
                    <div key={item.label} className="flex items-center gap-2">
                      <span className={cn("w-2 h-2 rounded-full border border-white shadow-sm", item.color)} />
                      <span className="text-xs text-muted-foreground">{item.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Live status indicator */}
            <div className="absolute top-4 left-4 bg-white/95 backdrop-blur-sm rounded-xl border border-border px-3 py-2 shadow-sm flex items-center gap-2">
              {wsConnected ? (
                <>
                  <Radio className="w-3.5 h-3.5 text-emerald-500 animate-pulse" />
                  <span className="text-xs text-muted-foreground">
                    Live WS · {liveDevices.length} device{liveDevices.length !== 1 ? "s" : ""}
                    {lastUpdate ? ` · ${lastUpdate.toLocaleTimeString()}` : ""}
                  </span>
                </>
              ) : (
                <>
                  <RefreshCw className="w-3.5 h-3.5 text-emerald-500 animate-spin" style={{ animationDuration: "4s" }} />
                  <span className="text-xs text-muted-foreground">Live data · updates every 15s</span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </PortalLayout>
  );
}
