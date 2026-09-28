/**
 * Gate Controller QR Scanner
 * ===========================
 * Admin-only page at /portal/validate-qr.
 *
 * Uses the browser's MediaDevices API to capture a live camera feed,
 * decodes QR codes frame-by-frame with jsQR, and calls
 * trpc.devices.validateQrCode for server-side HMAC + expiry verification.
 *
 * Result card:
 *  - Green (valid)  → device name, plaza, lane, expiry countdown
 *  - Red   (invalid) → reason (expired / tampered / wrong scheme)
 */
import { useCallback, useEffect, useRef, useState } from "react";
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
  Camera,
  CameraOff,
  RefreshCw,
  ScanLine,
  Keyboard,
  Clock,
  MapPin,
  Cpu,
} from "lucide-react";
import jsQR from "jsqr";

// ── Types ─────────────────────────────────────────────────────────────────────

type ValidationResult = {
  valid: boolean;
  reason: string;
  serial?: string;
  plaza?: string;
  lane?: string;
  expiresAt?: number | null;
  scannedAt: number;
};

// ── Expiry countdown helper ───────────────────────────────────────────────────

function useCountdown(expiresAt: number | null | undefined) {
  const [remaining, setRemaining] = useState<string | null>(null);

  useEffect(() => {
    if (!expiresAt) {
      setRemaining(null);
      return;
    }
    function tick() {
      const diff = expiresAt! - Date.now();
      if (diff <= 0) {
        setRemaining("Expired");
        return;
      }
      const h = Math.floor(diff / 3_600_000);
      const m = Math.floor((diff % 3_600_000) / 60_000);
      const s = Math.floor((diff % 60_000) / 1_000);
      setRemaining(
        h > 0
          ? `${h}h ${m}m ${s}s`
          : m > 0
          ? `${m}m ${s}s`
          : `${s}s`
      );
    }
    tick();
    const id = setInterval(tick, 1_000);
    return () => clearInterval(id);
  }, [expiresAt]);

  return remaining;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function QrScanner() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [lastUri, setLastUri] = useState<string>("");
  const [manualUri, setManualUri] = useState<string>("");
  const [manualMode, setManualMode] = useState(false);
  const [result, setResult] = useState<ValidationResult | null>(null);
  const [scanHistory, setScanHistory] = useState<ValidationResult[]>([]);

  // Cooldown to avoid re-scanning the same QR multiple times per second
  const lastScannedRef = useRef<string>("");
  const cooldownRef = useRef<number>(0);

  const validateMutation = trpc.devices.validateQrCode.useMutation({
    onSuccess: (data, variables) => {
      const r: ValidationResult = {
        valid: data.valid,
        reason: data.reason,
        serial: data.serial ?? undefined,
        plaza: data.plaza ?? undefined,
        lane: data.lane ?? undefined,
        expiresAt: data.expiresAt ? new Date(data.expiresAt).getTime() : null,
        scannedAt: Date.now(),
      };
      setResult(r);
      setScanHistory((prev) => [r, ...prev].slice(0, 20));
      lastScannedRef.current = variables.uri;
      cooldownRef.current = Date.now() + 3_000;
    },
    onError: (err) => {
      const r: ValidationResult = {
        valid: false,
        reason: err.message,
        scannedAt: Date.now(),
      };
      setResult(r);
      setScanHistory((prev) => [r, ...prev].slice(0, 20));
    },
  });

  // ── Camera management ─────────────────────────────────────────────────────

  const stopCamera = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraActive(false);
    setScanning(false);
  }, []);

  const startCamera = useCallback(async () => {
    setCameraError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraActive(true);
      setScanning(true);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Camera access denied";
      setCameraError(msg);
    }
  }, []);

  // ── Frame scanning loop ───────────────────────────────────────────────────

  useEffect(() => {
    if (!scanning) return;

    function scanFrame() {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState < 2) {
        rafRef.current = requestAnimationFrame(scanFrame);
        return;
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        rafRef.current = requestAnimationFrame(scanFrame);
        return;
      }

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: "dontInvert",
      });

      if (code && code.data) {
        const uri = code.data;
        const now = Date.now();
        if (uri !== lastScannedRef.current || now > cooldownRef.current) {
          setLastUri(uri);
          validateMutation.mutate({ uri });
        }
      }

      rafRef.current = requestAnimationFrame(scanFrame);
    }

    rafRef.current = requestAnimationFrame(scanFrame);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [scanning, validateMutation]);

  // ── Cleanup on unmount ────────────────────────────────────────────────────

  useEffect(() => {
    return () => stopCamera();
  }, [stopCamera]);

  // ── Manual validation ─────────────────────────────────────────────────────

  function handleManualValidate() {
    if (!manualUri.trim()) return;
    setLastUri(manualUri.trim());
    validateMutation.mutate({ uri: manualUri.trim() });
  }

  // ── Countdown for current result ──────────────────────────────────────────

  const countdown = useCountdown(result?.expiresAt);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <PortalLayout title="Gate QR Scanner" subtitle="Validate NigerianPass station QR codes">
      <div className="max-w-5xl mx-auto space-y-6 p-4">

        {/* ── Header controls ── */}
        <div className="flex flex-wrap gap-3 items-center justify-between">
          <div className="flex gap-2">
            {!cameraActive ? (
              <Button onClick={startCamera} className="gap-2">
                <Camera className="w-4 h-4" />
                Start Camera
              </Button>
            ) : (
              <Button variant="outline" onClick={stopCamera} className="gap-2">
                <CameraOff className="w-4 h-4" />
                Stop Camera
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => setManualMode((v) => !v)}
              className="gap-2"
            >
              <Keyboard className="w-4 h-4" />
              {manualMode ? "Hide Manual" : "Manual Input"}
            </Button>
          </div>
          {cameraActive && (
            <Badge variant="secondary" className="gap-1 animate-pulse">
              <ScanLine className="w-3 h-3" />
              Scanning…
            </Badge>
          )}
        </div>

        {/* ── Camera error ── */}
        {cameraError && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
            <strong>Camera error:</strong> {cameraError}. Try manual input below.
          </div>
        )}

        {/* ── Main content grid ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

          {/* ── Left: camera + manual ── */}
          <div className="space-y-4">
            {/* Camera viewport */}
            <Card className="overflow-hidden">
              <CardContent className="p-0 relative">
                <video
                  ref={videoRef}
                  className={`w-full aspect-video object-cover bg-black ${cameraActive ? "" : "hidden"}`}
                  playsInline
                  muted
                />
                {/* Hidden canvas for jsQR processing */}
                <canvas ref={canvasRef} className="hidden" />

                {/* Placeholder when camera is off */}
                {!cameraActive && (
                  <div className="w-full aspect-video bg-muted flex flex-col items-center justify-center gap-3 text-muted-foreground">
                    <Camera className="w-12 h-12 opacity-30" />
                    <p className="text-sm">Camera inactive</p>
                    <p className="text-xs opacity-60">Click "Start Camera" to begin scanning</p>
                  </div>
                )}

                {/* Scan overlay */}
                {cameraActive && (
                  <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                    <div className="w-48 h-48 border-2 border-primary/80 rounded-lg relative">
                      {/* Corner decorations */}
                      <div className="absolute top-0 left-0 w-6 h-6 border-t-4 border-l-4 border-primary rounded-tl" />
                      <div className="absolute top-0 right-0 w-6 h-6 border-t-4 border-r-4 border-primary rounded-tr" />
                      <div className="absolute bottom-0 left-0 w-6 h-6 border-b-4 border-l-4 border-primary rounded-bl" />
                      <div className="absolute bottom-0 right-0 w-6 h-6 border-b-4 border-r-4 border-primary rounded-br" />
                      {/* Scan line animation */}
                      <div className="absolute left-1 right-1 h-0.5 bg-primary/70 animate-bounce top-1/2" />
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Manual input */}
            {manualMode && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Manual URI Entry</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div>
                    <Label htmlFor="manual-uri" className="text-xs text-muted-foreground">
                      Paste a nigerianpass:// URI
                    </Label>
                    <Input
                      id="manual-uri"
                      value={manualUri}
                      onChange={(e) => setManualUri(e.target.value)}
                      placeholder="nigerianpass://station/NP-NFC-LIE-001?..."
                      className="font-mono text-xs mt-1"
                      onKeyDown={(e) => e.key === "Enter" && handleManualValidate()}
                    />
                  </div>
                  <Button
                    onClick={handleManualValidate}
                    disabled={!manualUri.trim() || validateMutation.isPending}
                    className="w-full gap-2"
                  >
                    {validateMutation.isPending ? (
                      <RefreshCw className="w-4 h-4 animate-spin" />
                    ) : (
                      <CheckCircle2 className="w-4 h-4" />
                    )}
                    Validate
                  </Button>
                </CardContent>
              </Card>
            )}

            {/* Last scanned URI (truncated) */}
            {lastUri && (
              <p className="text-xs text-muted-foreground font-mono truncate px-1">
                Last: {lastUri}
              </p>
            )}
          </div>

          {/* ── Right: result + history ── */}
          <div className="space-y-4">
            {/* Current result card */}
            {result ? (
              <Card
                className={`border-2 ${
                  result.valid
                    ? "border-green-500 bg-green-50 dark:bg-green-950/20"
                    : "border-red-500 bg-red-50 dark:bg-red-950/20"
                }`}
              >
                <CardContent className="pt-5 space-y-4">
                  {/* Status banner */}
                  <div className="flex items-center gap-3">
                    {result.valid ? (
                      <CheckCircle2 className="w-10 h-10 text-green-600 shrink-0" />
                    ) : (
                      <XCircle className="w-10 h-10 text-red-600 shrink-0" />
                    )}
                    <div>
                      <p className={`text-xl font-bold ${result.valid ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}`}>
                        {result.valid ? "VALID" : "INVALID"}
                      </p>
                      <p className="text-sm text-muted-foreground">{result.reason}</p>
                    </div>
                  </div>

                  {/* Device details (only for valid) */}
                  {result.valid && result.serial && (
                    <>
                      <Separator />
                      <div className="grid grid-cols-2 gap-3 text-sm">
                        <div className="flex items-center gap-2">
                          <Cpu className="w-4 h-4 text-muted-foreground shrink-0" />
                          <div>
                            <p className="text-xs text-muted-foreground">Device Serial</p>
                            <p className="font-mono font-medium">{result.serial}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <MapPin className="w-4 h-4 text-muted-foreground shrink-0" />
                          <div>
                            <p className="text-xs text-muted-foreground">Plaza</p>
                            <p className="font-medium truncate max-w-[120px]" title={result.plaza}>{result.plaza}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <ScanLine className="w-4 h-4 text-muted-foreground shrink-0" />
                          <div>
                            <p className="text-xs text-muted-foreground">Lane</p>
                            <p className="font-medium">{result.lane}</p>
                          </div>
                        </div>
                        {result.expiresAt && (
                          <div className="flex items-center gap-2">
                            <Clock className="w-4 h-4 text-muted-foreground shrink-0" />
                            <div>
                              <p className="text-xs text-muted-foreground">Expires in</p>
                              <p className={`font-medium tabular-nums ${countdown === "Expired" ? "text-red-600" : "text-green-600"}`}>
                                {countdown ?? "—"}
                              </p>
                            </div>
                          </div>
                        )}
                        {result.expiresAt === null && (
                          <div className="flex items-center gap-2">
                            <Clock className="w-4 h-4 text-muted-foreground shrink-0" />
                            <div>
                              <p className="text-xs text-muted-foreground">Expiry</p>
                              <p className="font-medium text-muted-foreground">No expiry (legacy)</p>
                            </div>
                          </div>
                        )}
                      </div>
                    </>
                  )}

                  <p className="text-xs text-muted-foreground">
                    Scanned at {new Date(result.scannedAt).toLocaleTimeString()}
                  </p>
                </CardContent>
              </Card>
            ) : (
              <Card className="border-dashed">
                <CardContent className="pt-8 pb-8 flex flex-col items-center gap-3 text-muted-foreground">
                  <ScanLine className="w-10 h-10 opacity-30" />
                  <p className="text-sm">No scan yet</p>
                  <p className="text-xs opacity-60">Point camera at a NigerianPass QR code</p>
                </CardContent>
              </Card>
            )}

            {/* Scan history */}
            {scanHistory.length > 0 && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium flex items-center justify-between">
                    Recent Scans
                    <Badge variant="outline" className="text-xs">{scanHistory.length}</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="max-h-64 overflow-y-auto divide-y">
                    {scanHistory.map((r, i) => (
                      <div key={i} className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-muted/40 transition-colors">
                        {r.valid ? (
                          <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
                        ) : (
                          <XCircle className="w-4 h-4 text-red-500 shrink-0" />
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="font-mono text-xs truncate">{r.serial ?? "—"}</p>
                          <p className="text-xs text-muted-foreground truncate">{r.reason}</p>
                        </div>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {new Date(r.scannedAt).toLocaleTimeString()}
                        </span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </PortalLayout>
  );
}
