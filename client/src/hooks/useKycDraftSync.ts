/**
 * useKycDraftSync
 * ================
 * Bridges the IndexedDB form-draft store with the tRPC `sync.submitKycDraft`
 * procedure, providing full offline-first KYC submission:
 *
 *  1. submitOrQueue(type, formData)
 *     - If online: calls trpc.sync.submitKycDraft directly.
 *     - If offline: serialises the payload into the IndexedDB retry queue
 *       (label = "Submit KYC Draft — <type>") and shows a toast.
 *
 *  2. Auto-resume on reconnect
 *     - Listens to the `window.online` event.
 *     - Scans the retry queue for pending KYC draft items.
 *     - Replays them via trpc.sync.submitKycDraft (not raw fetch) so tRPC
 *       auth cookies are included automatically.
 *     - Emits a toast notification per item: success / permanent failure.
 *
 *  3. Exposes queue state so the UI can show a "1 draft queued" badge.
 *
 * Usage:
 *   const { submitOrQueue, queuedDraftCount, isReplaying } = useKycDraftSync();
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import {
  enqueueRetry,
  getPendingRetries,
  deleteRetryItem,
  updateRetryItem,
  RetryItem,
} from "@/lib/offline";

// ── Constants ─────────────────────────────────────────────────────────────────

const KYC_DRAFT_LABEL_PREFIX = "Submit KYC Draft";
const MAX_REPLAY_ATTEMPTS = 5;

// ── Types ─────────────────────────────────────────────────────────────────────

export type KycType = "driver" | "vehicle" | "fleet";

export interface KycDraftPayload {
  type: KycType;
  formData: Record<string, unknown>;
  clientVersion?: number;
  draftId?: string;
}

export interface KycDraftSyncResult {
  referenceId: string;
  status: string;
  createdAt: number;
}

export interface UseKycDraftSyncReturn {
  /** Submit the KYC draft immediately if online, or queue it for later. */
  submitOrQueue: (payload: KycDraftPayload) => Promise<{ queued: boolean; result?: KycDraftSyncResult }>;
  /** Number of KYC draft items currently pending in the retry queue. */
  queuedDraftCount: number;
  /** True while a background replay of queued drafts is in progress. */
  isReplaying: boolean;
  /** Manually trigger a replay of all pending KYC drafts (e.g. after manual reconnect). */
  triggerReplay: () => Promise<void>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isKycDraftItem(item: RetryItem): boolean {
  return item.label.startsWith(KYC_DRAFT_LABEL_PREFIX) && item.status === "pending";
}

function buildQueueLabel(type: KycType): string {
  return `${KYC_DRAFT_LABEL_PREFIX} — ${type}`;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useKycDraftSync(): UseKycDraftSyncReturn {
  const [queuedDraftCount, setQueuedDraftCount] = useState(0);
  const [isReplaying, setIsReplaying] = useState(false);
  const replayRunningRef = useRef(false);

  // tRPC mutation for direct submission (online path)
  const submitMutation = trpc.sync.submitKycDraft.useMutation();

  // ── Refresh queue count ───────────────────────────────────────────────────
  const refreshQueueCount = useCallback(async () => {
    const items = await getPendingRetries();
    const kycItems = items.filter(isKycDraftItem);
    setQueuedDraftCount(kycItems.length);
  }, []);

  // ── Poll queue count every 15 seconds ────────────────────────────────────
  useEffect(() => {
    refreshQueueCount();
    const interval = setInterval(refreshQueueCount, 15_000);
    return () => clearInterval(interval);
  }, [refreshQueueCount]);

  // ── Replay pending KYC drafts ─────────────────────────────────────────────
  const triggerReplay = useCallback(async () => {
    if (replayRunningRef.current || !navigator.onLine) return;
    replayRunningRef.current = true;
    setIsReplaying(true);

    try {
      const items = await getPendingRetries();
      const kycItems = items.filter(isKycDraftItem);

      if (kycItems.length === 0) return;

      let succeeded = 0;
      let permanentlyFailed = 0;

      for (const item of kycItems) {
        if (!item.id) continue;

        // Parse the serialised payload
        let payload: KycDraftPayload;
        try {
          payload = JSON.parse(item.body ?? "{}") as KycDraftPayload;
        } catch {
          await updateRetryItem(item.id, { status: "failed" });
          permanentlyFailed++;
          continue;
        }

        // Mark as processing
        await updateRetryItem(item.id, {
          status: "processing",
          attempts: item.attempts + 1,
        });

        try {
          // Use tRPC mutation directly so auth cookies are included
          const result = await submitMutation.mutateAsync({
            type: payload.type,
            formData: payload.formData,
            clientVersion: payload.clientVersion ?? 1,
            draftId: payload.draftId,
          });

          // Success — remove from queue
          await deleteRetryItem(item.id);
          succeeded++;

          toast.success(`KYC draft submitted`, {
            description: `Reference: ${result.referenceId}`,
          });
        } catch (err: unknown) {
          const isClientError =
            err instanceof Error &&
            (err.message.includes("400") ||
              err.message.includes("401") ||
              err.message.includes("403") ||
              err.message.includes("422"));

          if (isClientError || item.attempts >= MAX_REPLAY_ATTEMPTS) {
            // Permanent failure — don't retry
            await updateRetryItem(item.id, { status: "failed" });
            permanentlyFailed++;
            toast.error(`KYC draft submission failed permanently`, {
              description: `${payload.type} draft could not be submitted after ${item.attempts + 1} attempts.`,
            });
          } else {
            // Transient failure — reset to pending for next attempt
            await updateRetryItem(item.id, { status: "pending" });
          }
        }
      }

      if (succeeded > 0 && permanentlyFailed === 0) {
        toast.success(`${succeeded} offline KYC draft${succeeded > 1 ? "s" : ""} submitted`, {
          description: "Your applications have been sent to the server.",
        });
      }
    } finally {
      replayRunningRef.current = false;
      setIsReplaying(false);
      await refreshQueueCount();
    }
  }, [submitMutation, refreshQueueCount]);

  // ── Auto-replay on reconnect ──────────────────────────────────────────────
  useEffect(() => {
    const handleOnline = () => {
      // Slight delay to let the connection stabilise
      setTimeout(() => triggerReplay(), 2000);
    };
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [triggerReplay]);

  // ── Submit or queue ───────────────────────────────────────────────────────
  const submitOrQueue = useCallback(
    async (payload: KycDraftPayload): Promise<{ queued: boolean; result?: KycDraftSyncResult }> => {
      if (navigator.onLine) {
        // Online path: submit directly via tRPC
        const result = await submitMutation.mutateAsync({
          type: payload.type,
          formData: payload.formData,
          clientVersion: payload.clientVersion ?? 1,
          draftId: payload.draftId,
        });
        return {
          queued: false,
            result: {
              referenceId: result.referenceId,
              status: result.status,
              createdAt: result.createdAt instanceof Date ? result.createdAt.getTime() : Number(result.createdAt),
            },
        };
      } else {
        // Offline path: persist to IndexedDB retry queue
        await enqueueRetry({
          url: "/api/trpc/sync.submitKycDraft",
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          label: buildQueueLabel(payload.type),
          maxAttempts: MAX_REPLAY_ATTEMPTS,
        });
        await refreshQueueCount();
        toast.info("KYC draft saved for later", {
          description: "Your application will be submitted automatically when you reconnect.",
        });
        return { queued: true };
      }
    },
    [submitMutation, refreshQueueCount]
  );

  return {
    submitOrQueue,
    queuedDraftCount,
    isReplaying,
    triggerReplay,
  };
}
