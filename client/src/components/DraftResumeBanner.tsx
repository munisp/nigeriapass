/**
 * DraftResumeBanner
 *
 * Shown at the top of a form when a saved draft is found in IndexedDB.
 * Lets the user resume from where they left off or start fresh.
 */
import { motion } from "framer-motion";
import { History, Trash2, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormDraft } from "@/lib/offline";

interface DraftResumeBannerProps {
  draft: FormDraft;
  onResume: () => void;
  onDiscard: () => void;
  formLabel?: string;
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (days > 0) return `${days} day${days > 1 ? "s" : ""} ago`;
  if (hours > 0) return `${hours} hour${hours > 1 ? "s" : ""} ago`;
  if (mins > 0) return `${mins} minute${mins > 1 ? "s" : ""} ago`;
  return "just now";
}

export default function DraftResumeBanner({ draft, onResume, onDiscard, formLabel = "form" }: DraftResumeBannerProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-blue-50 border border-blue-200 rounded-2xl p-4 mb-6"
    >
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl bg-blue-100 flex items-center justify-center shrink-0">
          <History className="w-4 h-4 text-blue-600" />
        </div>
        <div className="flex-1">
          <h4 className="font-semibold text-blue-900 text-sm mb-0.5">
            Saved draft found
          </h4>
          <p className="text-xs text-blue-700">
            You started this {formLabel} {timeAgo(draft.updatedAt)}.
            {draft.step > 0 && ` You were on step ${draft.step + 1}.`}
            {" "}Resume where you left off?
          </p>
          <div className="flex items-center gap-2 mt-3">
            <Button
              size="sm"
              onClick={onResume}
              className="bg-blue-600 hover:bg-blue-700 text-white gap-1.5 text-xs"
            >
              <ArrowRight className="w-3.5 h-3.5" />
              Resume Draft
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={onDiscard}
              className="text-blue-600 hover:text-blue-800 hover:bg-blue-100 gap-1.5 text-xs"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Start Fresh
            </Button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
