/**
 * LivenessCapture — Real-time liveness detection component
 *
 * Design: Premium Civic — Navy authority base, Emerald success, Amber challenge
 *
 * Flow:
 *  1. Request camera permission via getUserMedia
 *  2. Stream video to <video> element
 *  3. Load MediaPipe FaceMesh via CDN (no npm bundle needed)
 *  4. Detect face landmarks every animation frame
 *  5. Issue active challenge (blink / turn left / turn right / smile / nod)
 *  6. Detect challenge completion via landmark geometry
 *  7. Capture selfie frame as base64 JPEG
 *  8. Call doc-intelligence gRPC service via REST proxy for passive liveness score
 *  9. Report final score + selfie blob to parent via onComplete callback
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Camera, CheckCircle2, AlertCircle, Loader2, RefreshCw, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// ─── Server-side liveness verification ───────────────────────────────────────
// The score/pass decision MUST come from the backend anti-spoofing service.
// There is no client-side fallback: if the service is unreachable the UI shows
// a blocking "liveness unavailable" error instead of inventing a score.
const LIVENESS_ENDPOINT =
  (import.meta.env.VITE_LIVENESS_API_URL as string | undefined) ??
  "/api/onboarding/liveness/passive-verify";

async function requestLivenessScore(
  selfieBlob: Blob,
  completedChallenges: string[]
): Promise<{ passed: boolean; score: number }> {
  const form = new FormData();
  form.append("selfie", selfieBlob, "selfie.jpg");
  form.append("challenges", JSON.stringify(completedChallenges));
  const res = await fetch(LIVENESS_ENDPOINT, {
    method: "POST",
    body: form,
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Liveness service returned HTTP ${res.status}`);
  const data = (await res.json()) as { passed?: unknown; score?: unknown };
  if (typeof data.passed !== "boolean" || typeof data.score !== "number") {
    throw new Error("Liveness service returned an invalid response");
  }
  return { passed: data.passed, score: data.score };
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type Challenge = "blink" | "turn_left" | "turn_right" | "smile" | "nod";

type Landmark = { x: number; y: number; z: number };
type FaceLandmarks = Landmark[];

interface LivenessResult {
  passed: boolean;
  score: number;
  selfieBlob: Blob | null;
  challengeCompleted: Challenge;
}

interface Props {
  onComplete: (result: LivenessResult) => void;
  onError?: (msg: string) => void;
  challengeCount?: number;
}

// ─── Landmark indices (MediaPipe Face Mesh) ───────────────────────────────────
const LEFT_EYE_TOP = 159;
const LEFT_EYE_BOTTOM = 145;
const RIGHT_EYE_TOP = 386;
const RIGHT_EYE_BOTTOM = 374;
const LEFT_MOUTH = 61;
const RIGHT_MOUTH = 291;
const UPPER_LIP = 13;
const LOWER_LIP = 14;
const NOSE_TIP = 1;
const LEFT_CHEEK = 234;
const RIGHT_CHEEK = 454;

// ─── Geometry helpers ─────────────────────────────────────────────────────────
function eyeAspectRatio(lm: FaceLandmarks, top: number, bottom: number): number {
  return Math.abs(lm[top].y - lm[bottom].y);
}

function headYaw(lm: FaceLandmarks): number {
  // Positive = turned right, negative = turned left
  const noseTip = lm[NOSE_TIP].x;
  const leftCheek = lm[LEFT_CHEEK].x;
  const rightCheek = lm[RIGHT_CHEEK].x;
  const center = (leftCheek + rightCheek) / 2;
  return (noseTip - center) / (rightCheek - leftCheek);
}

function mouthAspectRatio(lm: FaceLandmarks): number {
  const mouthWidth = Math.abs(lm[RIGHT_MOUTH].x - lm[LEFT_MOUTH].x);
  const mouthHeight = Math.abs(lm[LOWER_LIP].y - lm[UPPER_LIP].y);
  return mouthHeight / (mouthWidth + 1e-6);
}

// ─── Challenge definitions ────────────────────────────────────────────────────
const CHALLENGES: { id: Challenge; label: string; instruction: string; emoji: string }[] = [
  { id: "blink", label: "Blink twice", instruction: "Slowly blink both eyes twice", emoji: "👁️" },
  { id: "turn_left", label: "Turn head left", instruction: "Slowly turn your head to the left", emoji: "⬅️" },
  { id: "turn_right", label: "Turn head right", instruction: "Slowly turn your head to the right", emoji: "➡️" },
  { id: "smile", label: "Smile", instruction: "Give a natural smile", emoji: "😊" },
  { id: "nod", label: "Nod slowly", instruction: "Nod your head up and down once", emoji: "⬆️" },
];

// ─── Component ────────────────────────────────────────────────────────────────
export default function LivenessCapture({ onComplete, onError, challengeCount = 2 }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const faceMeshRef = useRef<unknown>(null);
  const animFrameRef = useRef<number>(0);

  const [phase, setPhase] = useState<"idle" | "requesting" | "detecting" | "challenge" | "verifying" | "done" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [faceDetected, setFaceDetected] = useState(false);
  const [currentChallenge, setCurrentChallenge] = useState<typeof CHALLENGES[0] | null>(null);
  const [challengeProgress, setChallengeProgress] = useState(0); // 0–100
  const [completedChallenges, setCompletedChallenges] = useState<Challenge[]>([]);
  const [livenessScore, setLivenessScore] = useState(0);
  const [selfieDataUrl, setSelfieDataUrl] = useState<string | null>(null);

  // Blink detection state
  const blinkCountRef = useRef(0);
  const eyeClosedRef = useRef(false);
  const challengeProgressRef = useRef(0);
  const nodPhaseRef = useRef<"up" | "down" | "done">("up");
  const baselineYRef = useRef<number | null>(null);

  // ─── Cleanup ────────────────────────────────────────────────────────────────
  const cleanup = useCallback(() => {
    cancelAnimationFrame(animFrameRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => () => cleanup(), [cleanup]);

  // ─── Start camera ───────────────────────────────────────────────────────────
  const startCamera = useCallback(async () => {
    setPhase("requesting");
    setErrorMsg("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      await loadFaceMesh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Camera access denied";
      setErrorMsg(msg);
      setPhase("error");
      onError?.(msg);
    }
  }, [onError]);

  // ─── Load MediaPipe FaceMesh from CDN ───────────────────────────────────────
  const loadFaceMesh = useCallback(async () => {
    setPhase("detecting");
    try {
      // Dynamically load MediaPipe from CDN — avoids large npm bundle
      if (!(window as unknown as Record<string, unknown>)["FaceMesh"]) {
        await new Promise<void>((resolve, reject) => {
          const s = document.createElement("script");
          s.src = "https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4/face_mesh.js";
          s.crossOrigin = "anonymous";
          s.onload = () => resolve();
          s.onerror = () => reject(new Error("Failed to load MediaPipe"));
          document.head.appendChild(s);
        });
      }

      const FaceMeshClass = (window as unknown as Record<string, unknown>)["FaceMesh"] as new (opts: unknown) => unknown;
      const fm = new FaceMeshClass({
        locateFile: (file: string) =>
          `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4/${file}`,
      });

      (fm as { setOptions: (opts: unknown) => void }).setOptions({
        maxNumFaces: 1,
        refineLandmarks: true,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });

      (fm as { onResults: (cb: (r: { multiFaceLandmarks: FaceLandmarks[][] }) => void) => void }).onResults(handleFaceResults);
      faceMeshRef.current = fm;

      startDetectionLoop();
    } catch {
      // MediaPipe CDN unavailable — fail closed: no simulated liveness.
      cleanup();
      const msg = "Liveness unavailable — the face-detection library could not be loaded. Check your connection and retry.";
      setErrorMsg(msg);
      setPhase("error");
      onError?.(msg);
    }
  }, [cleanup, onError]);

  // ─── Detection loop ─────────────────────────────────────────────────────────
  const startDetectionLoop = useCallback(() => {
    const detect = async () => {
      if (!videoRef.current || !faceMeshRef.current) return;
      if (videoRef.current.readyState >= 2) {
        await (faceMeshRef.current as { send: (opts: { image: HTMLVideoElement }) => Promise<void> }).send({ image: videoRef.current });
      }
      animFrameRef.current = requestAnimationFrame(detect);
    };
    animFrameRef.current = requestAnimationFrame(detect);
  }, []);

  // ─── Face results handler ───────────────────────────────────────────────────
  const handleFaceResults = useCallback((results: { multiFaceLandmarks: FaceLandmarks[][] }) => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!results.multiFaceLandmarks || results.multiFaceLandmarks.length === 0) {
      setFaceDetected(false);
      return;
    }

    setFaceDetected(true);
    const lm = results.multiFaceLandmarks[0] as unknown as FaceLandmarks;

    // Draw minimal face oval guide
    drawFaceOval(ctx, canvas.width, canvas.height);

    // Process active challenge
    if (currentChallenge) {
      processChallengeFrame(lm, currentChallenge.id);
    }
  }, [currentChallenge]);

  // ─── Draw face oval ─────────────────────────────────────────────────────────
  const drawFaceOval = (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    ctx.save();
    ctx.strokeStyle = faceDetected ? "#10b981" : "#f59e0b";
    ctx.lineWidth = 3;
    ctx.setLineDash(faceDetected ? [] : [8, 4]);
    ctx.beginPath();
    ctx.ellipse(w / 2, h / 2, w * 0.28, h * 0.42, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  };

  // ─── Challenge frame processor ───────────────────────────────────────────────
  const processChallengeFrame = useCallback((lm: FaceLandmarks, challenge: Challenge) => {
    switch (challenge) {
      case "blink": {
        const leftEAR = eyeAspectRatio(lm, LEFT_EYE_TOP, LEFT_EYE_BOTTOM);
        const rightEAR = eyeAspectRatio(lm, RIGHT_EYE_TOP, RIGHT_EYE_BOTTOM);
        const avgEAR = (leftEAR + rightEAR) / 2;
        const BLINK_THRESHOLD = 0.015;
        if (avgEAR < BLINK_THRESHOLD && !eyeClosedRef.current) {
          eyeClosedRef.current = true;
        } else if (avgEAR >= BLINK_THRESHOLD && eyeClosedRef.current) {
          eyeClosedRef.current = false;
          blinkCountRef.current++;
          const progress = Math.min((blinkCountRef.current / 2) * 100, 100);
          challengeProgressRef.current = progress;
          setChallengeProgress(progress);
          if (blinkCountRef.current >= 2) completeChallenge();
        }
        break;
      }
      case "turn_left": {
        const yaw = headYaw(lm);
        const progress = Math.min(Math.max((-yaw - 0.1) / 0.25, 0), 1) * 100;
        challengeProgressRef.current = progress;
        setChallengeProgress(progress);
        if (progress >= 100) completeChallenge();
        break;
      }
      case "turn_right": {
        const yaw = headYaw(lm);
        const progress = Math.min(Math.max((yaw - 0.1) / 0.25, 0), 1) * 100;
        challengeProgressRef.current = progress;
        setChallengeProgress(progress);
        if (progress >= 100) completeChallenge();
        break;
      }
      case "smile": {
        const mar = mouthAspectRatio(lm);
        const progress = Math.min(Math.max((mar - 0.04) / 0.08, 0), 1) * 100;
        challengeProgressRef.current = progress;
        setChallengeProgress(progress);
        if (progress >= 100) completeChallenge();
        break;
      }
      case "nod": {
        const noseY = lm[NOSE_TIP].y;
        if (baselineYRef.current === null) baselineYRef.current = noseY;
        const delta = noseY - baselineYRef.current;
        if (nodPhaseRef.current === "up" && delta < -0.04) {
          nodPhaseRef.current = "down";
          setChallengeProgress(50);
        } else if (nodPhaseRef.current === "down" && delta > -0.01) {
          nodPhaseRef.current = "done";
          setChallengeProgress(100);
          completeChallenge();
        }
        break;
      }
    }
  }, []);

  // ─── Complete a challenge ───────────────────────────────────────────────────
  const completeChallenge = useCallback(() => {
    if (!currentChallenge) return;
    cancelAnimationFrame(animFrameRef.current);

    setCompletedChallenges(prev => {
      const updated = [...prev, currentChallenge.id];
      if (updated.length >= challengeCount) {
        // All challenges done — capture selfie and verify
        captureSelfieAndVerify(updated);
      } else {
        // Pick next challenge
        const remaining = CHALLENGES.filter(c => !updated.includes(c.id));
        const next = remaining[Math.floor(Math.random() * remaining.length)];
        setCurrentChallenge(next);
        setChallengeProgress(0);
        blinkCountRef.current = 0;
        eyeClosedRef.current = false;
        challengeProgressRef.current = 0;
        nodPhaseRef.current = "up";
        baselineYRef.current = null;
        startDetectionLoop();
      }
      return updated;
    });
  }, [currentChallenge, challengeCount, startDetectionLoop]);

  // ─── Capture selfie and call liveness API ───────────────────────────────────
  const captureSelfieAndVerify = useCallback(async (completed: Challenge[]) => {
    setPhase("verifying");
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;

    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    setSelfieDataUrl(dataUrl);

    // Convert to blob
    const blob = await (await fetch(dataUrl)).blob();

    try {
      // Score and pass/fail come from the server anti-spoofing service only
      const result = await requestLivenessScore(blob, completed);
      setLivenessScore(Math.round(result.score * 100));
      cleanup();
      if (result.passed) {
        setPhase("done");
      } else {
        setErrorMsg("Liveness check failed (server anti-spoofing score too low). Please retry in good lighting, without masks or photos of photos.");
        setPhase("error");
      }
      onComplete({
        passed: result.passed,
        score: Math.round(result.score * 100),
        selfieBlob: blob,
        challengeCompleted: completed[completed.length - 1],
      });
    } catch (err) {
      // Fail closed — never invent a liveness score
      cleanup();
      const msg = `Liveness unavailable — verification service could not be reached. Please retry. (${err instanceof Error ? err.message : "network error"})`;
      setErrorMsg(msg);
      setPhase("error");
      onError?.(msg);
    }
  }, [cleanup, onComplete, onError]);

  // ─── Start challenge after face detected ─────────────────────────────────────
  useEffect(() => {
    if (phase === "detecting" && faceDetected && !currentChallenge) {
      const challenge = CHALLENGES[Math.floor(Math.random() * CHALLENGES.length)];
      setCurrentChallenge(challenge);
      setPhase("challenge");
    }
  }, [phase, faceDetected, currentChallenge]);

  // ─── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col items-center gap-4 w-full">
      {/* Camera viewport */}
      <div className="relative w-full max-w-sm aspect-[4/3] rounded-2xl overflow-hidden bg-slate-900 border-2 border-border shadow-xl">
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-cover scale-x-[-1]"
          playsInline
          muted
          autoPlay
        />
        {/* Face overlay canvas */}
        <canvas
          ref={overlayCanvasRef}
          className="absolute inset-0 w-full h-full scale-x-[-1]"
          width={640}
          height={480}
        />
        {/* Hidden capture canvas */}
        <canvas ref={canvasRef} className="hidden" />

        {/* Phase overlays */}
        <AnimatePresence>
          {phase === "idle" && (
            <motion.div
              key="idle"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="absolute inset-0 flex flex-col items-center justify-center bg-slate-900/90 gap-4"
            >
              <div className="w-16 h-16 rounded-full bg-white/10 flex items-center justify-center">
                <Camera className="w-8 h-8 text-white" />
              </div>
              <p className="text-white text-sm font-medium">Camera not started</p>
              <Button size="sm" onClick={startCamera} className="bg-emerald-600 hover:bg-emerald-700">
                Start Camera
              </Button>
            </motion.div>
          )}

          {phase === "requesting" && (
            <motion.div
              key="requesting"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="absolute inset-0 flex flex-col items-center justify-center bg-slate-900/90 gap-3"
            >
              <Loader2 className="w-10 h-10 text-white animate-spin" />
              <p className="text-white text-sm">Requesting camera access…</p>
            </motion.div>
          )}

          {phase === "detecting" && !faceDetected && (
            <motion.div
              key="detecting"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="absolute bottom-4 left-0 right-0 flex justify-center"
            >
              <div className="bg-amber-500/90 text-white text-xs font-medium px-4 py-2 rounded-full flex items-center gap-2">
                <Eye className="w-3.5 h-3.5" />
                Position your face in the oval
              </div>
            </motion.div>
          )}

          {phase === "verifying" && (
            <motion.div
              key="verifying"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="absolute inset-0 flex flex-col items-center justify-center bg-slate-900/80 gap-3"
            >
              <Loader2 className="w-10 h-10 text-emerald-400 animate-spin" />
              <p className="text-white text-sm font-medium">Verifying liveness…</p>
            </motion.div>
          )}

          {phase === "done" && selfieDataUrl && (
            <motion.div
              key="done"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              className="absolute inset-0 flex flex-col items-center justify-center bg-emerald-900/80 gap-3"
            >
              <CheckCircle2 className="w-12 h-12 text-emerald-400" />
              <p className="text-white text-sm font-bold">Liveness Verified</p>
              <p className="text-emerald-300 text-xs">Score: {livenessScore}% · anti-spoofing scored server-side</p>
            </motion.div>
          )}

          {phase === "error" && (
            <motion.div
              key="error"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              className="absolute inset-0 flex flex-col items-center justify-center bg-red-900/80 gap-3 p-4"
            >
              <AlertCircle className="w-10 h-10 text-red-300" />
              <p className="text-white text-sm text-center">{errorMsg}</p>
              <Button size="sm" variant="outline" onClick={startCamera} className="text-white border-white/30">
                <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Retry
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Challenge instruction */}
      <AnimatePresence mode="wait">
        {currentChallenge && (phase === "challenge" || phase === "detecting") && (
          <motion.div
            key={currentChallenge.id}
            initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
            className="w-full max-w-sm"
          >
            <div className="bg-white border border-border rounded-xl p-4 shadow-sm">
              <div className="flex items-center gap-3 mb-3">
                <span className="text-2xl">{currentChallenge.emoji}</span>
                <div>
                  <div className="font-semibold text-foreground text-sm" style={{ fontFamily: 'Sora, sans-serif' }}>
                    {currentChallenge.label}
                  </div>
                  <div className="text-xs text-muted-foreground">{currentChallenge.instruction}</div>
                </div>
              </div>
              {/* Progress bar */}
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <motion.div
                  className="h-full bg-emerald-500 rounded-full"
                  animate={{ width: `${challengeProgress}%` }}
                  transition={{ duration: 0.1 }}
                />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Completed challenges */}
      {completedChallenges.length > 0 && (
        <div className="flex gap-2 flex-wrap justify-center">
          {completedChallenges.map(c => {
            const ch = CHALLENGES.find(x => x.id === c);
            return (
              <span key={c} className="flex items-center gap-1 text-xs bg-emerald-50 text-emerald-700 border border-emerald-200 px-2.5 py-1 rounded-full font-medium">
                <CheckCircle2 className="w-3 h-3" />
                {ch?.label}
              </span>
            );
          })}
        </div>
      )}

      {/* Start button */}
      {phase === "idle" && (
        <Button onClick={startCamera} className="w-full max-w-sm bg-[#1B2B4B] hover:bg-[#243660] text-white">
          <Camera className="w-4 h-4 mr-2" />
          Start Liveness Check
        </Button>
      )}
    </div>
  );
}
