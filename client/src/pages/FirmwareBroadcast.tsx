/**
 * Firmware Broadcast Dashboard
 * =============================
 * Admin-only page at /portal/firmware-broadcast.
 *
 * Allows admins to:
 *  1. Select a toll plaza
 *  2. Optionally specify a target firmware version
 *  3. Broadcast a firmware update request to all devices at that plaza
 *  4. View a per-device progress list (sent / skipped / failed)
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import PortalLayout from "@/components/PortalLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  CheckCircle2,
  XCircle,
  SkipForward,
  Radio,
  RefreshCw,
  Cpu,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  Clock,
  TrendingDown,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

type DeviceResult = {
  id: number;
  serial: string;
  name: string;
  status: "sent" | "skipped" | "failed";
  reason?: string;
  targetVersion: string;
};

type BroadcastResult = {
  plaza: string;
  total: number;
  sent: number;
  skipped: number;
  failed: number;
  results: DeviceResult[];
};

// ── Status badge ──────────────────────────────────────────────────────────────

function DeviceStatusBadge({ status, reason }: { status: DeviceResult["status"]; reason?: string }) {
  if (status === "sent") {
    return (
      <Badge className="gap-1 bg-green-100 text-green-700 border-green-200 hover:bg-green-100">
        <CheckCircle2 className="w-3 h-3" /> Sent
      </Badge>
    );
  }
  if (status === "skipped") {
    return (
      <Badge variant="secondary" className="gap-1">
        <SkipForward className="w-3 h-3" /> Skipped
        {reason && <span className="text-xs opacity-70 ml-1">({reason})</span>}
      </Badge>
    );
  }
  return (
    <Badge className="gap-1 bg-red-100 text-red-700 border-red-200 hover:bg-red-100">
      <XCircle className="w-3 h-3" /> Failed
    </Badge>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function FirmwareBroadcast() {
  const [plaza, setPlaza] = useState("");
  const [targetVersion, setTargetVersion] = useState("");
  const [broadcastResult, setBroadcastResult] = useState<BroadcastResult | null>(null);
  const [showDetails, setShowDetails] = useState(true);
  const [history, setHistory] = useState<BroadcastResult[]>([]);

  // Fetch plaza summary for the dropdown / suggestions
  const { data: plazaSummary } = trpc.devices.plazaSummary.useQuery(undefined, {
    staleTime: 30_000,
  });

  // Live firmware status — polls every 30 seconds
  const { data: firmwareStatus, dataUpdatedAt } = trpc.devices.getFirmwareBroadcastStatus.useQuery(
    { plaza: plaza.trim() || undefined },
    { refetchInterval: 30_000, staleTime: 25_000 },
  );

  const broadcastMutation = trpc.devices.broadcastFirmwareUpdate.useMutation({
    onSuccess: (data) => {
      setBroadcastResult(data);
      setHistory((prev) => [data, ...prev].slice(0, 10));
      setShowDetails(true);
    },
  });

  const plazaNames = plazaSummary?.map((p) => p.plaza) ?? [];

  function handleBroadcast() {
    if (!plaza.trim()) return;
    broadcastMutation.mutate({
      plaza: plaza.trim(),
      targetVersion: targetVersion.trim() || undefined,
    });
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <PortalLayout
      title="Firmware Broadcast"
      subtitle="Send firmware update requests to all devices at a plaza"
    >
      <div className="max-w-4xl mx-auto space-y-6 p-4">

        {/* ── Live firmware status counter ── */}
        {firmwareStatus && (
          <div className="grid grid-cols-3 gap-3">
            <Card className="border-muted">
              <CardContent className="pt-4 pb-3 text-center">
                <p className="text-2xl font-bold">{firmwareStatus.total}</p>
                <p className="text-xs text-muted-foreground mt-0.5">Total Devices</p>
              </CardContent>
            </Card>
            <Card className="border-green-200 bg-green-50/40">
              <CardContent className="pt-4 pb-3 text-center">
                <p className="text-2xl font-bold text-green-700">{firmwareStatus.upToDate}</p>
                <p className="text-xs text-green-600 mt-0.5 flex items-center justify-center gap-1">
                  <CheckCircle2 className="w-3 h-3" /> Up to date
                </p>
              </CardContent>
            </Card>
            <Card className={firmwareStatus.pending > 0 ? "border-amber-200 bg-amber-50/40" : "border-muted"}>
              <CardContent className="pt-4 pb-3 text-center">
                <p className={`text-2xl font-bold ${firmwareStatus.pending > 0 ? "text-amber-700" : "text-muted-foreground"}`}>
                  {firmwareStatus.pending}
                </p>
                <p className={`text-xs mt-0.5 flex items-center justify-center gap-1 ${firmwareStatus.pending > 0 ? "text-amber-600" : "text-muted-foreground"}`}>
                  <TrendingDown className="w-3 h-3" /> Pending update
                </p>
              </CardContent>
            </Card>
          </div>
        )}
        {dataUpdatedAt > 0 && (
          <p className="text-xs text-muted-foreground flex items-center gap-1 -mt-3">
            <Clock className="w-3 h-3" />
            Status last checked {new Date(dataUpdatedAt).toLocaleTimeString()} — auto-refreshes every 30 s
          </p>
        )}

        {/* ── Broadcast form ── */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Radio className="w-4 h-4 text-primary" />
              Broadcast Configuration
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Plaza selector */}
            <div className="space-y-1.5">
              <Label htmlFor="plaza-input">Toll Plaza</Label>
              <Input
                id="plaza-input"
                list="plaza-list"
                value={plaza}
                onChange={(e) => setPlaza(e.target.value)}
                placeholder="e.g. Lagos–Ibadan Expressway Toll Plaza"
                className="max-w-lg"
              />
              <datalist id="plaza-list">
                {plazaNames.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
              <p className="text-xs text-muted-foreground">
                Partial match is supported — all devices whose plaza contains this string will be targeted.
              </p>
            </div>

            {/* Target version (optional) */}
            <div className="space-y-1.5">
              <Label htmlFor="target-version">Target Firmware Version <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Input
                id="target-version"
                value={targetVersion}
                onChange={(e) => setTargetVersion(e.target.value)}
                placeholder="Leave blank to use each device's latestFirmware"
                className="max-w-xs font-mono"
              />
            </div>

            {/* Plaza preview */}
            {plaza && plazaSummary && (
              <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Matching plazas</p>
                {plazaSummary
                  .filter((p) => p.plaza.toLowerCase().includes(plaza.toLowerCase()))
                  .map((p) => (
                    <div key={p.plaza} className="flex items-center justify-between text-sm">
                      <span className="font-medium truncate max-w-xs">{p.plaza}</span>
                      <div className="flex gap-2 shrink-0">
                        <Badge variant="outline" className="text-xs">{p.total} devices</Badge>
                        <Badge className="text-xs bg-green-100 text-green-700 border-green-200">{p.online} online</Badge>
                        {p.offline > 0 && <Badge className="text-xs bg-red-100 text-red-700 border-red-200">{p.offline} offline</Badge>}
                      </div>
                    </div>
                  ))}
                {plazaSummary.filter((p) => p.plaza.toLowerCase().includes(plaza.toLowerCase())).length === 0 && (
                  <p className="text-sm text-muted-foreground">No plazas match this search.</p>
                )}
              </div>
            )}

            {/* Broadcast button */}
            <div className="flex items-center gap-3 pt-1">
              <Button
                onClick={handleBroadcast}
                disabled={!plaza.trim() || broadcastMutation.isPending}
                className="gap-2"
              >
                {broadcastMutation.isPending ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : (
                  <Radio className="w-4 h-4" />
                )}
                {broadcastMutation.isPending ? "Broadcasting…" : "Broadcast Firmware Update"}
              </Button>
              {broadcastMutation.isError && (
                <p className="text-sm text-destructive flex items-center gap-1">
                  <AlertTriangle className="w-4 h-4" />
                  {broadcastMutation.error.message}
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* ── Result card ── */}
        {broadcastResult && (
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-green-600" />
                  Broadcast Complete — {broadcastResult.plaza}
                </CardTitle>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowDetails((v) => !v)}
                  className="gap-1 text-xs"
                >
                  {showDetails ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  {showDetails ? "Hide" : "Show"} Details
                </Button>
              </div>

              {/* Summary pills */}
              <div className="flex flex-wrap gap-2 pt-1">
                <Badge variant="outline" className="gap-1">
                  <Cpu className="w-3 h-3" /> {broadcastResult.total} devices
                </Badge>
                <Badge className="gap-1 bg-green-100 text-green-700 border-green-200">
                  <CheckCircle2 className="w-3 h-3" /> {broadcastResult.sent} sent
                </Badge>
                <Badge variant="secondary" className="gap-1">
                  <SkipForward className="w-3 h-3" /> {broadcastResult.skipped} skipped
                </Badge>
                {broadcastResult.failed > 0 && (
                  <Badge className="gap-1 bg-red-100 text-red-700 border-red-200">
                    <XCircle className="w-3 h-3" /> {broadcastResult.failed} failed
                  </Badge>
                )}
              </div>
            </CardHeader>

            {showDetails && (
              <>
                <Separator />
                <CardContent className="p-0">
                  <div className="divide-y max-h-80 overflow-y-auto">
                    {broadcastResult.results.map((r) => (
                      <div
                        key={r.id}
                        className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-muted/30 transition-colors"
                      >
                        <div className="flex-1 min-w-0">
                          <p className="font-medium truncate">{r.name}</p>
                          <p className="text-xs text-muted-foreground font-mono">{r.serial}</p>
                        </div>
                        {r.targetVersion && (
                          <span className="text-xs font-mono text-muted-foreground shrink-0">
                            → {r.targetVersion}
                          </span>
                        )}
                        <DeviceStatusBadge status={r.status} reason={r.reason} />
                      </div>
                    ))}
                  </div>
                </CardContent>
              </>
            )}
          </Card>
        )}

        {/* ── History ── */}
        {history.length > 1 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Recent Broadcasts</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y">
                {history.slice(1).map((h, i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-3 text-sm">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{h.plaza}</p>
                      <p className="text-xs text-muted-foreground">
                        {h.total} devices — {h.sent} sent, {h.skipped} skipped
                        {h.failed > 0 && `, ${h.failed} failed`}
                      </p>
                    </div>
                    <Badge variant="outline" className="text-xs shrink-0">
                      {h.sent}/{h.total}
                    </Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </PortalLayout>
  );
}
