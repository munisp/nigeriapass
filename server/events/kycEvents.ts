/**
 * KYC Status Event Emitter
 * ========================
 * A singleton EventEmitter that bridges the admin tRPC router
 * (which fires status_changed events) to the WebSocket layer
 * (which forwards them to the connected applicant's browser).
 *
 * Usage:
 *   Server-side emitter: getKycStatusEmitter().emit("status_changed", payload)
 *   WebSocket listener:  getKycStatusEmitter().on("status_changed", handler)
 */
import { EventEmitter } from "events";

export interface KycStatusChangedEvent {
  /** The application's stable reference ID (e.g. "DRV-XKQP7") */
  referenceId: string;
  /** The applicant's user ID (used to route the WS message to the right client) */
  userId: number | null;
  /** The new status after the admin action */
  newStatus:
    | "submitted"
    | "under_review"
    | "approved"
    | "rejected"
    | "requires_resubmission";
  /** Admin's review notes / rejection reason */
  reviewNotes: string | null;
  /** KYC score (0–100) assigned by the admin */
  kycScore: number | null;
  /** Unix timestamp (ms) of when the review was completed */
  reviewedAt: number;
  /** Display name of the admin who performed the review */
  reviewedBy: string;
}

export interface TierUpgradedEvent {
  /** The user ID whose wallet tier was upgraded */
  userId: number;
  /** The previous tier */
  oldTier: "basic" | "standard" | "premium";
  /** The new (higher) tier */
  newTier: "basic" | "standard" | "premium";
  /** New wallet balance in kobo after the credit that triggered the upgrade */
  newBalanceKobo: number;
}

export interface WalletCreditedEvent {
  /** The user ID whose wallet was credited */
  userId: number;
  /** Amount credited in kobo */
  amountKobo: number;
  /** New wallet balance in kobo after credit */
  newBalanceKobo: number;
  /** Payment provider reference */
  reference: string;
  /** Payment provider slug */
  provider: string;
}

// Typed EventEmitter interface
interface KycEventMap {
  status_changed: [KycStatusChangedEvent];
  wallet_credited: [WalletCreditedEvent];
  tier_upgraded: [TierUpgradedEvent];
}

class KycStatusEmitter extends EventEmitter {
  emit<K extends keyof KycEventMap>(event: K, ...args: KycEventMap[K]): boolean {
    return super.emit(event as string, ...args);
  }

  on<K extends keyof KycEventMap>(
    event: K,
    listener: (...args: KycEventMap[K]) => void
  ): this {
    return super.on(event as string, listener as (...args: unknown[]) => void);
  }

  off<K extends keyof KycEventMap>(
    event: K,
    listener: (...args: KycEventMap[K]) => void
  ): this {
    return super.off(event as string, listener as (...args: unknown[]) => void);
  }
}

// Singleton — shared across the entire server process
let _emitter: KycStatusEmitter | null = null;

export function getKycStatusEmitter(): KycStatusEmitter {
  if (!_emitter) {
    _emitter = new KycStatusEmitter();
    _emitter.setMaxListeners(100); // Support many concurrent WS connections
  }
  return _emitter;
}
