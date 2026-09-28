/**
 * useConflictResolution
 * =====================
 * Detects when an offline draft conflicts with the server version and
 * manages the resolution lifecycle.
 *
 * Usage:
 *   const { conflict, resolveConflict, dismissConflict } = useConflictResolution({
 *     formId: "driver-kyc",
 *     serverData: serverApplication,
 *     serverTimestamp: serverApplication?.updatedAt,
 *   });
 *
 *   if (conflict) {
 *     return <ConflictResolutionDialog
 *       localDraft={conflict.local}
 *       serverVersion={conflict.server}
 *       onResolve={resolveConflict}
 *       onDismiss={dismissConflict}
 *     />;
 *   }
 */
import { useState, useEffect, useCallback } from "react";
import { getDraft, deleteDraft, FormDraft } from "@/lib/offline";
import type { ConflictVersion } from "@/components/ConflictResolutionDialog";

export interface ConflictState {
  local: ConflictVersion;
  server: ConflictVersion;
  draft: FormDraft;
}

interface UseConflictResolutionOptions {
  formId: string;
  serverData: Record<string, unknown> | null | undefined;
  serverTimestamp: number | Date | null | undefined;
  /** Minimum age of draft (ms) before it's considered a conflict. Default: 0 */
  minDraftAgeMs?: number;
  /** If true, only flag a conflict when the server is strictly newer than the draft */
  requireServerNewer?: boolean;
}

interface UseConflictResolutionResult {
  conflict: ConflictState | null;
  isChecking: boolean;
  resolveConflict: (merged: Record<string, unknown>, strategy: "local" | "server" | "custom") => void;
  dismissConflict: () => void;
}

export function useConflictResolution({
  formId,
  serverData,
  serverTimestamp,
  minDraftAgeMs = 0,
  requireServerNewer = true,
}: UseConflictResolutionOptions): UseConflictResolutionResult {
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [isChecking, setIsChecking] = useState(true);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    if (resolved) return;
    if (!serverData) {
      setIsChecking(false);
      return;
    }

    let cancelled = false;

    async function check() {
      setIsChecking(true);
      try {
        const draft = await getDraft(formId);
        if (!draft || cancelled) {
          setIsChecking(false);
          return;
        }

        // Check draft age
        if (minDraftAgeMs > 0 && Date.now() - draft.updatedAt < minDraftAgeMs) {
          setIsChecking(false);
          return;
        }

        const serverTs = serverTimestamp instanceof Date
          ? serverTimestamp.getTime()
          : (serverTimestamp ?? 0);

        // Only flag conflict if server is newer than the draft
        if (requireServerNewer && serverTs <= draft.updatedAt) {
          setIsChecking(false);
          return;
        }

        // Check if any fields actually differ
        const hasDiff = Object.keys({ ...draft.data, ...serverData }).some(
          key => JSON.stringify(draft.data[key]) !== JSON.stringify((serverData as Record<string, unknown>)[key])
        );

        if (!hasDiff) {
          // No actual differences — silently delete the stale draft
          await deleteDraft(formId);
          setIsChecking(false);
          return;
        }

        if (!cancelled) {
          setConflict({
            draft,
            local: {
              data: draft.data,
              timestamp: draft.updatedAt,
              label: "Your offline draft",
              version: draft.version,
            },
            server: {
              data: serverData as Record<string, unknown>,
              timestamp: serverTs,
              label: "Server version",
            },
          });
        }
      } catch (err) {
        console.warn("[ConflictResolution] Error checking draft:", err);
      } finally {
        if (!cancelled) setIsChecking(false);
      }
    }

    check();
    return () => { cancelled = true; };
  }, [formId, serverData, serverTimestamp, minDraftAgeMs, requireServerNewer, resolved]);

  const resolveConflict = useCallback(async (
    merged: Record<string, unknown>,
    strategy: "local" | "server" | "custom"
  ) => {
    if (!conflict) return;

    // Delete the draft since it's been resolved
    await deleteDraft(formId);
    setConflict(null);
    setResolved(true);

    console.log(`[ConflictResolution] Resolved "${formId}" with strategy: ${strategy}`, merged);
  }, [conflict, formId]);

  const dismissConflict = useCallback(async () => {
    if (!conflict) return;
    // Dismissing = keep server version, delete local draft
    await deleteDraft(formId);
    setConflict(null);
    setResolved(true);
  }, [conflict, formId]);

  return { conflict, isChecking, resolveConflict, dismissConflict };
}
