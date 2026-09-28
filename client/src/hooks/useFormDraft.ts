/**
 * useFormDraft
 *
 * Auto-saves form data to IndexedDB every 3 seconds (debounced).
 * Restores draft on mount. Clears draft on successful submission.
 *
 * Usage:
 *   const { draft, saveDraftNow, clearDraft, hasDraft } = useFormDraft("driver-kyc");
 *   // Pass draft.data to form defaultValues
 *   // Call saveDraftNow(formValues, currentStep) on each field change
 *   // Call clearDraft() after successful submission
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { saveDraft, getDraft, deleteDraft, FormDraft } from "@/lib/offline";

interface UseFormDraftReturn {
  draft: FormDraft | null;
  hasDraft: boolean;
  isSaving: boolean;
  lastSaved: Date | null;
  saveDraftNow: (data: Record<string, unknown>, step?: number) => Promise<void>;
  scheduleSave: (data: Record<string, unknown>, step?: number) => void;
  clearDraft: () => Promise<void>;
}

export function useFormDraft(formId: string): UseFormDraftReturn {
  const [draft, setDraft] = useState<FormDraft | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestDataRef = useRef<{ data: Record<string, unknown>; step: number } | null>(null);

  // Load draft on mount
  useEffect(() => {
    getDraft(formId).then(setDraft);
  }, [formId]);

  // Save before page unload (power outage / tab close)
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (latestDataRef.current) {
        // Synchronous-ish save using sendBeacon as fallback isn't available for IDB,
        // so we flush the debounce immediately
        const { data, step } = latestDataRef.current;
        saveDraft(formId, data, step); // fire-and-forget
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden" && latestDataRef.current) {
        const { data, step } = latestDataRef.current;
        saveDraft(formId, data, step);
      }
    });
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [formId]);

  const saveDraftNow = useCallback(async (data: Record<string, unknown>, step = 0) => {
    setIsSaving(true);
    try {
      await saveDraft(formId, data, step);
      const updated = await getDraft(formId);
      setDraft(updated);
      setLastSaved(new Date());
    } finally {
      setIsSaving(false);
    }
  }, [formId]);

  const scheduleSave = useCallback((data: Record<string, unknown>, step = 0) => {
    latestDataRef.current = { data, step };
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      saveDraftNow(data, step);
    }, 3000); // 3-second debounce
  }, [saveDraftNow]);

  const clearDraft = useCallback(async () => {
    await deleteDraft(formId);
    setDraft(null);
    setLastSaved(null);
    latestDataRef.current = null;
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, [formId]);

  return {
    draft,
    hasDraft: draft !== null,
    isSaving,
    lastSaved,
    saveDraftNow,
    scheduleSave,
    clearDraft,
  };
}
