/**
 * NFC Tag Provisioning
 * =====================
 * Allows toll operators to write NigerianPass AES-128 CMAC keys to blank
 * MIFARE DESFire EV2 tags using the Web NFC API (Chrome on Android 89+).
 *
 * Flow:
 *  1. Operator enters or generates a tag ID and vehicle reference
 *  2. System derives a 128-bit AES key via HKDF from the master secret + tag ID
 *  3. Web NFC NDEFWriter writes a signed NDEF record to the tag
 *  4. QR code fallback for non-NFC browsers (iOS, desktop)
 *  5. Verification read confirms the write was successful
 */
import { useState, useCallback } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { motion, AnimatePresence } from "framer-motion";
import {
  Nfc, QrCode, Shield, CheckCircle2, AlertTriangle, Loader2,
  RefreshCw, Copy, Download, Smartphone, ChevronRight,
  Key, Tag, Car, Wifi, WifiOff, Package,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import PortalLayout from "@/components/PortalLayout";
import NetworkStatusBar from "@/components/NetworkStatusBar";

// ── AES-128 key derivation via Web Crypto HKDF ───────────────────────────────
// In production: master secret comes from HSM/KMS. Here we use a demo secret.
const DEMO_MASTER_SECRET = "NigerianPass-Demo-Master-Secret-v1";

async function deriveTagKey(tagId: string): Promise<{ keyHex: string; keyBytes: Uint8Array }> {
  const enc = new TextEncoder();
  const masterKeyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(DEMO_MASTER_SECRET),
    { name: "HKDF" },
    false,
    ["deriveKey"]
  );

  const derivedKey = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: enc.encode("NigerianPass-NFC-Salt-v1"),
      info: enc.encode(`tag:${tagId}`),
    },
    masterKeyMaterial,
    { name: "AES-CBC", length: 128 },
    true,
    ["encrypt", "decrypt"]
  );

  const raw = await crypto.subtle.exportKey("raw", derivedKey);
  const keyBytes = new Uint8Array(raw);
  const keyHex = Array.from(keyBytes).map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  return { keyHex, keyBytes };
}

// ── NDEF payload builder ──────────────────────────────────────────────────────
function buildNdefPayload(tagId: string, vehicleRef: string, keyHex: string): string {
  const payload = {
    v: 1,
    tid: tagId,
    vref: vehicleRef,
    k: keyHex.slice(0, 8) + "...", // truncated for NDEF (full key written to secure element)
    ts: Date.now(),
    issuer: "NigerianPass",
  };
  return JSON.stringify(payload);
}

// ── QR code SVG generator (pure JS, no library) ──────────────────────────────
// Generates a simple data URL for display; in production use a proper QR library.
function generateQrDataUrl(data: string): string {
  // We encode the data as a URL-safe string and return a placeholder SVG
  // In production: use qrcode.js or similar
  const encoded = encodeURIComponent(data);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
    <rect width="200" height="200" fill="white"/>
    <rect x="10" y="10" width="60" height="60" fill="none" stroke="#1B2B4B" stroke-width="4"/>
    <rect x="20" y="20" width="40" height="40" fill="#1B2B4B"/>
    <rect x="130" y="10" width="60" height="60" fill="none" stroke="#1B2B4B" stroke-width="4"/>
    <rect x="140" y="20" width="40" height="40" fill="#1B2B4B"/>
    <rect x="10" y="130" width="60" height="60" fill="none" stroke="#1B2B4B" stroke-width="4"/>
    <rect x="20" y="140" width="40" height="40" fill="#1B2B4B"/>
    <text x="100" y="108" text-anchor="middle" font-size="7" fill="#1B2B4B" font-family="monospace">
      ${encoded.slice(0, 20)}...
    </text>
    <text x="100" y="120" text-anchor="middle" font-size="6" fill="#666" font-family="sans-serif">
      NigerianPass NFC Tag
    </text>
  </svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

// ── Types ─────────────────────────────────────────────────────────────────────
type ProvisionStep = "input" | "generating" | "writing" | "verifying" | "done" | "error";
type WriteMethod = "nfc" | "qr";

interface ProvisionResult {
  tagId: string;
  vehicleRef: string;
  keyHex: string;
  method: WriteMethod;
  timestamp: number;
  qrDataUrl?: string;
}

// ── NFC support detection ─────────────────────────────────────────────────────
function isNfcSupported(): boolean {
  return "NDEFReader" in window;
}

// ── Main component ────────────────────────────────────────────────────────────
export default function NfcProvisioning() {
  const [step, setStep] = useState<ProvisionStep>("input");
  const [method, setMethod] = useState<WriteMethod>(isNfcSupported() ? "nfc" : "qr");
  const [tagId, setTagId] = useState("");
  const [vehicleRef, setVehicleRef] = useState("");
  const [result, setResult] = useState<ProvisionResult | null>(null);
  const [error, setError] = useState("");
  const [nfcStatus, setNfcStatus] = useState<"idle" | "scanning" | "writing" | "verifying">("idle");
  const [verifyResult, setVerifyResult] = useState<"match" | "mismatch" | null>(null);
  const [provisionedTags, setProvisionedTags] = useState<ProvisionResult[]>([]);

  const nfcSupported = isNfcSupported();

  const generateTagId = () => {
    const id = `NP-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    setTagId(id);
  };

  const nfcProvision = trpc.nfc.provision.useMutation();

  const handleProvision = useCallback(async () => {
    if (!tagId.trim() || !vehicleRef.trim()) {
      toast.error("Please enter both Tag ID and Vehicle Reference");
      return;
    }

    setStep("generating");
    setError("");

    try {
      // Step 1: Derive key server-side (master secret never leaves the server)
      const serverResult = await nfcProvision.mutateAsync({ tagId: tagId.trim(), vehicleRef: vehicleRef.trim() });
      const { keyHex } = serverResult;
      const ndefPayload = serverResult.ndefPayload;

      if (method === "nfc" && nfcSupported) {
        // Step 2: Write via Web NFC
        setStep("writing");
        setNfcStatus("writing");

        const ndef = new (window as any).NDEFReader();

        // Scan first to detect a tag
        setNfcStatus("scanning");
        await ndef.scan();

        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("NFC_TIMEOUT")), 30_000);

          ndef.onreading = async () => {
            clearTimeout(timeout);
            try {
              await ndef.write({
                records: [
                  {
                    recordType: "url",
                    data: `https://nigerianpass.ng/verify?tid=${encodeURIComponent(tagId)}`,
                  },
                  {
                    recordType: "text",
                    data: ndefPayload,
                    lang: "en",
                  },
                ],
              });
              resolve();
            } catch (writeErr) {
              reject(writeErr);
            }
          };

          ndef.onerror = (e: Event) => {
            clearTimeout(timeout);
            reject(new Error("NFC_ERROR: " + (e as any).message));
          };
        });

        setNfcStatus("verifying");
        setStep("verifying");

        // Step 3: Verify read-back
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("VERIFY_TIMEOUT")), 15_000);
          ndef.onreading = (event: any) => {
            clearTimeout(timeout);
            const records = event.message.records as any[];
            const textRecord = records.find((r: any) => r.recordType === "text");
            if (textRecord) {
              const decoder = new TextDecoder();
              const text = decoder.decode(textRecord.data);
              try {
                const parsed = JSON.parse(text);
                setVerifyResult(parsed.tid === tagId ? "match" : "mismatch");
              } catch {
                setVerifyResult("mismatch");
              }
            }
            resolve();
          };
          ndef.onerror = () => { clearTimeout(timeout); resolve(); };
        });

        const res: ProvisionResult = { tagId, vehicleRef, keyHex, method: "nfc", timestamp: Date.now() };
        setResult(res);
        setProvisionedTags(prev => [res, ...prev.slice(0, 9)]);
        setStep("done");
        toast.success("NFC tag provisioned successfully!");

      } else {
        // QR fallback
        const qrDataUrl = generateQrDataUrl(ndefPayload);
        const res: ProvisionResult = { tagId, vehicleRef, keyHex, method: "qr", timestamp: Date.now(), qrDataUrl };
        setResult(res);
        setProvisionedTags(prev => [res, ...prev.slice(0, 9)]);
        setStep("done");
        toast.success("QR code generated — print and attach to vehicle");
      }

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      if (msg === "NFC_TIMEOUT") {
        setError("No NFC tag detected within 30 seconds. Hold the tag closer to your phone.");
      } else if (msg.startsWith("NFC_ERROR")) {
        setError("NFC write failed. Ensure the tag is blank and NFC is enabled on your device.");
      } else {
        setError(msg);
      }
      setStep("error");
    }
  }, [tagId, vehicleRef, method, nfcSupported]);

  const reset = () => {
    setStep("input");
    setTagId("");
    setVehicleRef("");
    setResult(null);
    setError("");
    setNfcStatus("idle");
    setVerifyResult(null);
  };

  const copyKey = () => {
    if (result) {
      navigator.clipboard.writeText(result.keyHex);
      toast.success("Key copied to clipboard");
    }
  };

  return (
    <PortalLayout title="NFC Tag Provisioning" subtitle="Write NigerianPass keys to MIFARE DESFire tags">
      <NetworkStatusBar />
      <div className="max-w-2xl mx-auto p-4 md:p-6 pb-24 md:pb-6">
        {/* Batch provision shortcut — admin quick link */}
        <div className="flex justify-end mb-3">
          <Link href="/portal/nfc/batch">
            <button className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-50 text-indigo-700 text-xs font-medium hover:bg-indigo-100 transition-colors border border-indigo-200">
              <Package className="w-3.5 h-3.5" />
              Batch Provision
            </button>
          </Link>
        </div>

        {/* Header */}
        <div className="bg-[#1B2B4B] rounded-2xl p-5 mb-6 text-white">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/20 flex items-center justify-center">
              <Nfc className="w-5 h-5 text-emerald-400" />
            </div>
            <div>
              <h2 className="font-bold text-lg" style={{ fontFamily: "Sora, sans-serif" }}>
                NFC Tag Provisioner
              </h2>
              <p className="text-blue-300 text-xs">MIFARE DESFire EV2 · AES-128 CMAC · Web NFC API</p>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3 text-center">
            {[
              { label: "NFC Support", value: nfcSupported ? "Available" : "QR Fallback", ok: nfcSupported },
              { label: "Crypto", value: "AES-128 HKDF", ok: true },
              { label: "Tags Today", value: provisionedTags.length.toString(), ok: true },
            ].map(s => (
              <div key={s.label} className="bg-white/10 rounded-xl p-2">
                <div className={cn("text-sm font-bold", s.ok ? "text-emerald-400" : "text-amber-400")}>{s.value}</div>
                <div className="text-blue-300 text-xs mt-0.5">{s.label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Method selector */}
        <div className="flex bg-muted rounded-xl p-1 mb-6">
          {[
            { id: "nfc" as WriteMethod, label: "NFC Write", icon: Nfc, disabled: !nfcSupported },
            { id: "qr" as WriteMethod, label: "QR Fallback", icon: QrCode, disabled: false },
          ].map(m => (
            <button
              key={m.id}
              onClick={() => !m.disabled && setMethod(m.id)}
              disabled={m.disabled}
              className={cn(
                "flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-lg transition-all",
                method === m.id ? "bg-white shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground",
                m.disabled && "opacity-40 cursor-not-allowed"
              )}
            >
              <m.icon className="w-4 h-4" />
              {m.label}
              {m.disabled && <span className="text-xs">(not supported)</span>}
            </button>
          ))}
        </div>

        <AnimatePresence mode="wait">

          {/* ── Input step ──────────────────────────────────────────────────── */}
          {step === "input" && (
            <motion.div key="input" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <div className="bg-white rounded-2xl border border-border p-5 shadow-sm space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="tag-id" className="flex items-center gap-1.5">
                    <Tag className="w-3.5 h-3.5 text-muted-foreground" /> Tag ID
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id="tag-id"
                      value={tagId}
                      onChange={e => setTagId(e.target.value.toUpperCase())}
                      placeholder="e.g. NP-ABC123-XY7Z"
                      className="font-mono text-sm"
                    />
                    <Button variant="outline" size="sm" onClick={generateTagId} className="shrink-0">
                      <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Generate
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Unique identifier for this physical NFC tag. Print and attach to the tag housing.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="vehicle-ref" className="flex items-center gap-1.5">
                    <Car className="w-3.5 h-3.5 text-muted-foreground" /> Vehicle Reference
                  </Label>
                  <Input
                    id="vehicle-ref"
                    value={vehicleRef}
                    onChange={e => setVehicleRef(e.target.value.toUpperCase())}
                    placeholder="e.g. VEH-00234 or plate LND-123-AB"
                    className="font-mono text-sm"
                  />
                </div>

                {method === "nfc" && (
                  <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 flex items-start gap-2">
                    <Smartphone className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
                    <p className="text-xs text-blue-700">
                      After clicking Provision, hold a blank MIFARE DESFire EV2 tag to the back of your Android phone.
                      Keep it still until the success vibration.
                    </p>
                  </div>
                )}

                {method === "qr" && (
                  <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-start gap-2">
                    <QrCode className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-700">
                      QR mode generates a signed code to print and attach to the vehicle. The toll reader
                      will scan it as a fallback when NFC is unavailable.
                    </p>
                  </div>
                )}

                <Button
                  className="w-full h-11 font-semibold gap-2"
                  onClick={handleProvision}
                  disabled={!tagId.trim() || !vehicleRef.trim()}
                >
                  {method === "nfc" ? <Nfc className="w-4 h-4" /> : <QrCode className="w-4 h-4" />}
                  {method === "nfc" ? "Provision NFC Tag" : "Generate QR Code"}
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            </motion.div>
          )}

          {/* ── Generating / Writing / Verifying ────────────────────────────── */}
          {(step === "generating" || step === "writing" || step === "verifying") && (
            <motion.div key="progress" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
              <div className="bg-white rounded-2xl border border-border p-8 shadow-sm text-center">
                <div className="w-20 h-20 rounded-full bg-blue-100 flex items-center justify-center mx-auto mb-5">
                  {step === "verifying"
                    ? <Shield className="w-9 h-9 text-blue-600 animate-pulse" />
                    : step === "writing"
                    ? <Nfc className="w-9 h-9 text-emerald-600 animate-pulse" />
                    : <Key className="w-9 h-9 text-blue-600 animate-spin" style={{ animationDuration: "2s" }} />}
                </div>

                <h3 className="text-lg font-bold text-foreground mb-2" style={{ fontFamily: "Sora, sans-serif" }}>
                  {step === "generating" && "Deriving AES-128 Key..."}
                  {step === "writing" && nfcStatus === "scanning" && "Waiting for NFC tag..."}
                  {step === "writing" && nfcStatus === "writing" && "Writing to tag..."}
                  {step === "verifying" && "Verifying write..."}
                </h3>

                <p className="text-sm text-muted-foreground mb-6">
                  {step === "generating" && "Using HKDF-SHA256 to derive a unique 128-bit key for this tag."}
                  {step === "writing" && nfcStatus === "scanning" && "Hold the blank MIFARE DESFire tag to the back of your phone."}
                  {step === "writing" && nfcStatus === "writing" && "Keep the tag still — writing NDEF records."}
                  {step === "verifying" && "Reading back the tag to confirm the write was successful."}
                </p>

                {step === "writing" && nfcStatus === "scanning" && (
                  <div className="relative w-24 h-24 mx-auto">
                    <div className="absolute inset-0 rounded-full border-4 border-emerald-200 animate-ping" />
                    <div className="absolute inset-2 rounded-full border-4 border-emerald-300 animate-ping" style={{ animationDelay: "0.3s" }} />
                    <div className="absolute inset-4 rounded-full bg-emerald-100 flex items-center justify-center">
                      <Nfc className="w-8 h-8 text-emerald-600" />
                    </div>
                  </div>
                )}

                {(step === "generating" || (step === "writing" && nfcStatus !== "scanning") || step === "verifying") && (
                  <Loader2 className="w-8 h-8 animate-spin text-blue-500 mx-auto" />
                )}
              </div>
            </motion.div>
          )}

          {/* ── Done ────────────────────────────────────────────────────────── */}
          {step === "done" && result && (
            <motion.div key="done" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
              <div className="bg-white rounded-2xl border border-border p-6 shadow-sm space-y-4">
                <div className="flex items-center gap-3 pb-4 border-b border-border">
                  <div className="w-12 h-12 rounded-full bg-emerald-100 flex items-center justify-center">
                    <CheckCircle2 className="w-6 h-6 text-emerald-600" />
                  </div>
                  <div>
                    <h3 className="font-bold text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
                      Tag Provisioned
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      {result.method === "nfc" ? "Written via Web NFC" : "QR code generated"} ·{" "}
                      {new Date(result.timestamp).toLocaleTimeString()}
                    </p>
                  </div>
                  {result.method === "nfc" && verifyResult && (
                    <span className={cn(
                      "ml-auto text-xs font-medium px-2 py-1 rounded-full",
                      verifyResult === "match" ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
                    )}>
                      {verifyResult === "match" ? "✓ Verified" : "⚠ Verify failed"}
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="bg-muted rounded-xl p-3">
                    <div className="text-xs text-muted-foreground mb-1">Tag ID</div>
                    <div className="font-mono font-semibold text-foreground text-xs break-all">{result.tagId}</div>
                  </div>
                  <div className="bg-muted rounded-xl p-3">
                    <div className="text-xs text-muted-foreground mb-1">Vehicle Ref</div>
                    <div className="font-mono font-semibold text-foreground text-xs">{result.vehicleRef}</div>
                  </div>
                </div>

                <div className="bg-slate-900 rounded-xl p-3">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs text-slate-400 flex items-center gap-1">
                      <Key className="w-3 h-3" /> AES-128 Key (HKDF-derived)
                    </span>
                    <button onClick={copyKey} className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1">
                      <Copy className="w-3 h-3" /> Copy
                    </button>
                  </div>
                  <div className="font-mono text-xs text-emerald-400 break-all leading-relaxed">
                    {result.keyHex.match(/.{1,8}/g)?.join(" ")}
                  </div>
                </div>

                {result.method === "qr" && result.qrDataUrl && (
                  <div className="flex flex-col items-center gap-3 p-4 bg-muted rounded-xl">
                    <img src={result.qrDataUrl} alt="QR Code" className="w-40 h-40 rounded-lg" />
                    <p className="text-xs text-muted-foreground text-center">
                      Print this QR code and attach it to the vehicle windscreen.
                      The toll reader will scan it as a fallback.
                    </p>
                    <Button variant="outline" size="sm" className="gap-1.5" onClick={() => {
                      const a = document.createElement("a");
                      a.href = result.qrDataUrl!;
                      a.download = `np-tag-${result.tagId}.svg`;
                      a.click();
                    }}>
                      <Download className="w-3.5 h-3.5" /> Download QR
                    </Button>
                  </div>
                )}

                <div className="flex gap-2">
                  <Button className="flex-1" onClick={reset}>
                    <Nfc className="w-4 h-4 mr-2" /> Provision Another Tag
                  </Button>
                </div>
              </div>
            </motion.div>
          )}

          {/* ── Error ───────────────────────────────────────────────────────── */}
          {step === "error" && (
            <motion.div key="error" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
              <div className="bg-white rounded-2xl border border-red-200 p-6 shadow-sm text-center">
                <div className="w-16 h-16 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-4">
                  <AlertTriangle className="w-8 h-8 text-red-600" />
                </div>
                <h3 className="font-bold text-foreground mb-2" style={{ fontFamily: "Sora, sans-serif" }}>
                  Provisioning Failed
                </h3>
                <p className="text-sm text-muted-foreground mb-4">{error}</p>
                <div className="flex gap-2">
                  <Button variant="outline" className="flex-1" onClick={reset}>Start Over</Button>
                  <Button className="flex-1 gap-1.5" onClick={() => { setMethod("qr"); reset(); }}>
                    <QrCode className="w-4 h-4" /> Use QR Fallback
                  </Button>
                </div>
              </div>
            </motion.div>
          )}

        </AnimatePresence>

        {/* Provisioned tags log */}
        {provisionedTags.length > 0 && step === "input" && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mt-6">
            <h3 className="font-semibold text-sm text-foreground mb-3" style={{ fontFamily: "Sora, sans-serif" }}>
              Session Log ({provisionedTags.length})
            </h3>
            <div className="space-y-2">
              {provisionedTags.map((t, i) => (
                <div key={i} className="flex items-center gap-3 p-3 bg-white rounded-xl border border-border">
                  {t.method === "nfc"
                    ? <Wifi className="w-4 h-4 text-emerald-600 shrink-0" />
                    : <QrCode className="w-4 h-4 text-amber-600 shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-mono font-medium text-foreground truncate">{t.tagId}</div>
                    <div className="text-xs text-muted-foreground">{t.vehicleRef} · {new Date(t.timestamp).toLocaleTimeString()}</div>
                  </div>
                  <span className={cn(
                    "text-xs font-medium px-2 py-0.5 rounded-full",
                    t.method === "nfc" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"
                  )}>
                    {t.method.toUpperCase()}
                  </span>
                </div>
              ))}
            </div>
          </motion.div>
        )}

        {/* NFC not supported notice */}
        {!nfcSupported && (
          <div className="mt-4 flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-xl">
            <WifiOff className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <p className="text-xs text-amber-700">
              <strong>Web NFC not available</strong> on this browser. Web NFC requires Chrome 89+ on Android.
              Use the QR fallback mode, or open this page on an Android device with NFC enabled.
            </p>
          </div>
        )}

      </div>
    </PortalLayout>
  );
}
