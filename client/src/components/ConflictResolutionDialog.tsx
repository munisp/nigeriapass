/**
 * ConflictResolutionDialog
 * ========================
 * Shown when an offline draft conflicts with a newer server version.
 * Presents a diff-style side-by-side view of the two versions and lets
 * the user choose which fields to keep.
 *
 * Props:
 *  - localDraft:   The draft saved to IndexedDB while offline
 *  - serverVersion: The version currently on the server
 *  - onResolve:    Called with the merged result the user chose
 *  - onDismiss:    Called when the user cancels (keeps server version)
 */
import { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  GitMerge, Clock, Server, HardDrive, ChevronDown, ChevronUp,
  CheckCircle, AlertTriangle, X, ArrowRight, RotateCcw, Save
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ConflictVersion {
  data: Record<string, unknown>;
  timestamp: number;
  label: string;  // e.g. "Your offline draft" or "Server version"
  version?: number;
}

export interface FieldConflict {
  key: string;
  label: string;
  localValue: unknown;
  serverValue: unknown;
  isDifferent: boolean;
}

interface ConflictResolutionDialogProps {
  localDraft: ConflictVersion;
  serverVersion: ConflictVersion;
  fieldLabels?: Record<string, string>;  // Maps field keys to human-readable labels
  onResolve: (merged: Record<string, unknown>, strategy: "local" | "server" | "custom") => void;
  onDismiss: () => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function computeConflicts(
  local: Record<string, unknown>,
  server: Record<string, unknown>,
  fieldLabels: Record<string, string>
): FieldConflict[] {
  const allKeys = new Set([...Object.keys(local), ...Object.keys(server)]);
  return Array.from(allKeys).map(key => ({
    key,
    label: fieldLabels[key] || key.replace(/_/g, " ").replace(/([A-Z])/g, " $1").trim(),
    localValue: local[key],
    serverValue: server[key],
    isDifferent: JSON.stringify(local[key]) !== JSON.stringify(server[key]),
  }));
}

// ── Field Row ─────────────────────────────────────────────────────────────────

interface FieldRowProps {
  conflict: FieldConflict;
  choice: "local" | "server" | null;
  onChoose: (key: string, choice: "local" | "server") => void;
}

function FieldRow({ conflict, choice, onChoose }: FieldRowProps) {
  const [expanded, setExpanded] = useState(false);
  const localStr = formatValue(conflict.localValue);
  const serverStr = formatValue(conflict.serverValue);
  const isLong = localStr.length > 60 || serverStr.length > 60;

  if (!conflict.isDifferent) {
    return (
      <div className="flex items-center gap-3 py-2.5 px-4 bg-gray-50/50">
        <CheckCircle className="w-4 h-4 text-green-500 shrink-0" />
        <span className="text-xs font-medium text-gray-600 w-32 shrink-0">{conflict.label}</span>
        <span className="text-xs text-gray-500 truncate">{localStr}</span>
        <span className="text-xs text-gray-400 ml-auto">Same in both</span>
      </div>
    );
  }

  return (
    <div className="border-l-2 border-amber-300 bg-amber-50/30">
      {/* Header row */}
      <div className="flex items-center gap-2 px-4 py-2.5">
        <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
        <span className="text-xs font-semibold text-gray-700 w-32 shrink-0">{conflict.label}</span>

        {isLong && (
          <button
            onClick={() => setExpanded(e => !e)}
            className="ml-auto text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1"
          >
            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {expanded ? "Collapse" : "Expand"}
          </button>
        )}
      </div>

      {/* Side-by-side comparison */}
      <div className="grid grid-cols-2 gap-0 px-4 pb-3">
        {/* Local draft */}
        <button
          onClick={() => onChoose(conflict.key, "local")}
          className={`relative text-left p-2.5 rounded-l-lg border transition-all ${
            choice === "local"
              ? "border-blue-400 bg-blue-50 ring-1 ring-blue-400"
              : "border-gray-200 bg-white hover:border-blue-300 hover:bg-blue-50/50"
          }`}
        >
          <div className="flex items-center gap-1.5 mb-1">
            <HardDrive className="w-3 h-3 text-blue-500" />
            <span className="text-xs font-medium text-blue-700">Your draft</span>
            {choice === "local" && <CheckCircle className="w-3 h-3 text-blue-500 ml-auto" />}
          </div>
          <p className={`text-xs text-gray-700 font-mono break-all ${!expanded && isLong ? "line-clamp-2" : ""}`}>
            {localStr}
          </p>
        </button>

        {/* Server version */}
        <button
          onClick={() => onChoose(conflict.key, "server")}
          className={`relative text-left p-2.5 rounded-r-lg border-t border-r border-b transition-all ${
            choice === "server"
              ? "border-green-400 bg-green-50 ring-1 ring-green-400"
              : "border-gray-200 bg-white hover:border-green-300 hover:bg-green-50/50"
          }`}
        >
          <div className="flex items-center gap-1.5 mb-1">
            <Server className="w-3 h-3 text-green-500" />
            <span className="text-xs font-medium text-green-700">Server</span>
            {choice === "server" && <CheckCircle className="w-3 h-3 text-green-500 ml-auto" />}
          </div>
          <p className={`text-xs text-gray-700 font-mono break-all ${!expanded && isLong ? "line-clamp-2" : ""}`}>
            {serverStr}
          </p>
        </button>
      </div>
    </div>
  );
}

// ── Main Dialog ───────────────────────────────────────────────────────────────

export default function ConflictResolutionDialog({
  localDraft,
  serverVersion,
  fieldLabels = {},
  onResolve,
  onDismiss,
}: ConflictResolutionDialogProps) {
  const conflicts = useMemo(
    () => computeConflicts(localDraft.data, serverVersion.data, fieldLabels),
    [localDraft.data, serverVersion.data, fieldLabels]
  );

  const conflictingFields = conflicts.filter(c => c.isDifferent);
  const sameFields = conflicts.filter(c => !c.isDifferent);

  // Per-field choices: "local" | "server" | null (unresolved)
  const [fieldChoices, setFieldChoices] = useState<Record<string, "local" | "server">>(() => {
    // Default: prefer local draft for conflicting fields (user's work)
    const defaults: Record<string, "local" | "server"> = {};
    conflicts.filter(c => c.isDifferent).forEach(c => { defaults[c.key] = "local"; });
    return defaults;
  });

  const [showSameFields, setShowSameFields] = useState(false);

  const handleChooseField = (key: string, choice: "local" | "server") => {
    setFieldChoices(prev => ({ ...prev, [key]: choice }));
  };

  const handleUseAll = (source: "local" | "server") => {
    const choices: Record<string, "local" | "server"> = {};
    conflictingFields.forEach(c => { choices[c.key] = source; });
    setFieldChoices(choices);
  };

  const unresolvedCount = conflictingFields.filter(c => !fieldChoices[c.key]).length;

  const handleConfirm = () => {
    // Build merged result
    const merged: Record<string, unknown> = { ...serverVersion.data };
    for (const conflict of conflicts) {
      const choice = fieldChoices[conflict.key];
      if (choice === "local") {
        merged[conflict.key] = conflict.localValue;
      } else {
        merged[conflict.key] = conflict.serverValue;
      }
    }

    // Determine strategy
    const allLocal = conflictingFields.every(c => fieldChoices[c.key] === "local");
    const allServer = conflictingFields.every(c => fieldChoices[c.key] === "server");
    const strategy = allLocal ? "local" : allServer ? "server" : "custom";

    onResolve(merged, strategy);
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4"
        onClick={e => { if (e.target === e.currentTarget) onDismiss(); }}
      >
        <motion.div
          initial={{ y: 60, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 60, opacity: 0 }}
          transition={{ type: "spring", damping: 25, stiffness: 300 }}
          className="bg-white w-full sm:max-w-2xl max-h-[90vh] rounded-t-3xl sm:rounded-2xl overflow-hidden flex flex-col shadow-2xl"
        >
          {/* Header */}
          <div className="flex items-start gap-3 px-5 py-4 border-b border-gray-100 bg-gradient-to-r from-amber-50 to-orange-50">
            <div className="w-10 h-10 rounded-xl bg-amber-100 flex items-center justify-center shrink-0">
              <GitMerge className="w-5 h-5 text-amber-600" />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-base font-bold text-gray-900">Sync Conflict Detected</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                Your offline draft differs from the server version. Choose which values to keep.
              </p>
            </div>
            <button onClick={onDismiss} className="p-1.5 rounded-lg hover:bg-amber-200 transition-colors">
              <X className="w-4 h-4 text-gray-500" />
            </button>
          </div>

          {/* Version metadata */}
          <div className="grid grid-cols-2 gap-0 border-b border-gray-100">
            <div className="flex items-center gap-2 px-5 py-3 bg-blue-50/50">
              <HardDrive className="w-4 h-4 text-blue-500" />
              <div>
                <p className="text-xs font-semibold text-blue-700">{localDraft.label}</p>
                <p className="text-xs text-blue-500">
                  <Clock className="w-2.5 h-2.5 inline mr-1" />
                  {new Date(localDraft.timestamp).toLocaleString()}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 px-5 py-3 bg-green-50/50 border-l border-gray-100">
              <Server className="w-4 h-4 text-green-500" />
              <div>
                <p className="text-xs font-semibold text-green-700">{serverVersion.label}</p>
                <p className="text-xs text-green-500">
                  <Clock className="w-2.5 h-2.5 inline mr-1" />
                  {new Date(serverVersion.timestamp).toLocaleString()}
                </p>
              </div>
            </div>
          </div>

          {/* Quick actions */}
          <div className="flex items-center gap-2 px-5 py-3 border-b border-gray-100 bg-gray-50/50">
            <span className="text-xs text-gray-500 mr-1">Use all from:</span>
            <button
              onClick={() => handleUseAll("local")}
              className="flex items-center gap-1.5 text-xs font-medium text-blue-700 bg-blue-100 hover:bg-blue-200 px-2.5 py-1 rounded-lg transition-colors"
            >
              <HardDrive className="w-3 h-3" />
              My draft
            </button>
            <button
              onClick={() => handleUseAll("server")}
              className="flex items-center gap-1.5 text-xs font-medium text-green-700 bg-green-100 hover:bg-green-200 px-2.5 py-1 rounded-lg transition-colors"
            >
              <Server className="w-3 h-3" />
              Server version
            </button>
            <span className="ml-auto text-xs text-amber-600 font-medium">
              {conflictingFields.length} conflict{conflictingFields.length !== 1 ? "s" : ""}
            </span>
          </div>

          {/* Conflict fields */}
          <div className="flex-1 overflow-y-auto">
            <div className="divide-y divide-gray-100">
              {conflictingFields.map(conflict => (
                <FieldRow
                  key={conflict.key}
                  conflict={conflict}
                  choice={fieldChoices[conflict.key] ?? null}
                  onChoose={handleChooseField}
                />
              ))}
            </div>

            {/* Same fields (collapsible) */}
            {sameFields.length > 0 && (
              <div className="border-t border-gray-100">
                <button
                  onClick={() => setShowSameFields(s => !s)}
                  className="w-full flex items-center justify-between px-4 py-3 text-xs text-gray-500 hover:bg-gray-50 transition-colors"
                >
                  <span className="flex items-center gap-2">
                    <CheckCircle className="w-3.5 h-3.5 text-green-500" />
                    {sameFields.length} field{sameFields.length !== 1 ? "s" : ""} are identical in both versions
                  </span>
                  {showSameFields ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                </button>
                {showSameFields && (
                  <div className="divide-y divide-gray-50">
                    {sameFields.map(conflict => (
                      <FieldRow
                        key={conflict.key}
                        conflict={conflict}
                        choice={null}
                        onChoose={() => {}}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center gap-3 px-5 py-4 border-t border-gray-100 bg-white">
            <button
              onClick={onDismiss}
              className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-800 px-3 py-2 rounded-xl hover:bg-gray-100 transition-colors"
            >
              <RotateCcw className="w-4 h-4" />
              Keep server version
            </button>
            <button
              onClick={handleConfirm}
              disabled={unresolvedCount > 0}
              className="ml-auto flex items-center gap-2 text-sm font-semibold text-white bg-green-600 hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed px-4 py-2 rounded-xl transition-colors"
            >
              <Save className="w-4 h-4" />
              {unresolvedCount > 0
                ? `Resolve ${unresolvedCount} remaining`
                : "Apply merge"
              }
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
