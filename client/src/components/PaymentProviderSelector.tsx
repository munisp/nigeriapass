/**
 * PaymentProviderSelector
 * =======================
 * A visual card-based selector for choosing between Paystack,
 * Flutterwave, and Interswitch when initiating a wallet top-up.
 *
 * Props:
 *  - value: currently selected provider slug
 *  - onChange: callback when user selects a provider
 *  - amountKobo: current top-up amount (used to show min/max warnings)
 */

import { cn } from "@/lib/utils";
import { CheckCircle2, AlertCircle } from "lucide-react";

export type PaymentProviderSlug = "paystack" | "flutterwave" | "interswitch";

export interface ProviderMeta {
  slug: PaymentProviderSlug;
  displayName: string;
  tagline: string;
  color: string;
  borderColor: string;
  bgColor: string;
  minAmountKobo: number;
  maxAmountKobo: number;
  features: string[];
  recommended?: boolean;
}

export const PAYMENT_PROVIDERS: ProviderMeta[] = [
  {
    slug: "paystack",
    displayName: "Paystack",
    tagline: "Card, Bank Transfer, USSD",
    color: "text-[#00c3f7]",
    borderColor: "border-[#00c3f7]",
    bgColor: "bg-[#00c3f7]/5",
    minAmountKobo: 10000,
    maxAmountKobo: 100000000,
    features: ["Instant settlement", "USSD support", "Bank transfer"],
    recommended: true,
  },
  {
    slug: "flutterwave",
    displayName: "Flutterwave",
    tagline: "Card, Bank, Mobile Money",
    color: "text-[#f5a623]",
    borderColor: "border-[#f5a623]",
    bgColor: "bg-[#f5a623]/5",
    minAmountKobo: 10000,
    maxAmountKobo: 500000000,
    features: ["Multi-currency", "Mobile money", "High limits"],
  },
  {
    slug: "interswitch",
    displayName: "Interswitch",
    tagline: "Quickteller · Verve · Mastercard",
    color: "text-[#e30613]",
    borderColor: "border-[#e30613]",
    bgColor: "bg-[#e30613]/5",
    minAmountKobo: 10000,
    maxAmountKobo: 200000000,
    features: ["Verve card support", "Bank-grade security", "Quickteller"],
  },
];

// ── SVG Logos ─────────────────────────────────────────────────────────────────

function PaystackLogo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 120 30" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="30" height="30" rx="6" fill="#00c3f7" />
      <path d="M8 10h14M8 15h10M8 20h12" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
      <text x="38" y="22" fontFamily="system-ui" fontWeight="700" fontSize="16" fill="#00c3f7">Paystack</text>
    </svg>
  );
}

function FlutterwaveLogo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 140 30" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="30" height="30" rx="6" fill="#f5a623" />
      <path d="M6 22 Q15 8 24 22" stroke="white" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      <path d="M10 22 Q15 12 20 22" stroke="white" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      <text x="38" y="22" fontFamily="system-ui" fontWeight="700" fontSize="16" fill="#f5a623">Flutterwave</text>
    </svg>
  );
}

function InterswitchLogo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 140 30" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="30" height="30" rx="6" fill="#e30613" />
      <path d="M8 8h14v6H8zM8 16h14v6H8z" fill="white" opacity="0.9" />
      <text x="38" y="22" fontFamily="system-ui" fontWeight="700" fontSize="14" fill="#e30613">Interswitch</text>
    </svg>
  );
}

const LOGOS: Record<PaymentProviderSlug, React.ComponentType<{ className?: string }>> = {
  paystack: PaystackLogo,
  flutterwave: FlutterwaveLogo,
  interswitch: InterswitchLogo,
};

// ── Component ─────────────────────────────────────────────────────────────────

interface PaymentProviderSelectorProps {
  value: PaymentProviderSlug;
  onChange: (slug: PaymentProviderSlug) => void;
  amountKobo?: number;
  className?: string;
}

export function PaymentProviderSelector({
  value,
  onChange,
  amountKobo = 0,
  className,
}: PaymentProviderSelectorProps) {
  return (
    <div className={cn("space-y-2", className)}>
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
        Choose Payment Provider
      </p>
      <div className="grid gap-2">
        {PAYMENT_PROVIDERS.map(provider => {
          const Logo = LOGOS[provider.slug];
          const isSelected = value === provider.slug;
          const isTooLow = amountKobo > 0 && amountKobo < provider.minAmountKobo;
          const isTooHigh = amountKobo > 0 && amountKobo > provider.maxAmountKobo;
          const isDisabled = isTooLow || isTooHigh;

          return (
            <button
              key={provider.slug}
              type="button"
              disabled={isDisabled}
              onClick={() => !isDisabled && onChange(provider.slug)}
              className={cn(
                "relative w-full text-left rounded-xl border-2 p-3 transition-all duration-150",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1",
                isSelected
                  ? `${provider.borderColor} ${provider.bgColor} shadow-sm`
                  : "border-border bg-white hover:border-muted-foreground/30 hover:bg-muted/20",
                isDisabled && "opacity-40 cursor-not-allowed"
              )}
            >
              <div className="flex items-start gap-3">
                {/* Logo */}
                <div className="shrink-0 pt-0.5">
                  <Logo className="h-5 w-auto" />
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold">{provider.displayName}</span>
                    {provider.recommended && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-medium">
                        Recommended
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">{provider.tagline}</p>
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {provider.features.map(f => (
                      <span key={f} className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                        {f}
                      </span>
                    ))}
                  </div>
                  {/* Limit warning */}
                  {isTooLow && (
                    <p className="text-[10px] text-amber-600 mt-1 flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" />
                      Min ₦{(provider.minAmountKobo / 100).toLocaleString()}
                    </p>
                  )}
                  {isTooHigh && (
                    <p className="text-[10px] text-red-600 mt-1 flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" />
                      Max ₦{(provider.maxAmountKobo / 100).toLocaleString()}
                    </p>
                  )}
                </div>

                {/* Selected indicator */}
                {isSelected && (
                  <CheckCircle2 className={cn("w-4 h-4 shrink-0 mt-0.5", provider.color)} />
                )}
              </div>
            </button>
          );
        })}
      </div>

      {/* Limits summary */}
      <p className="text-[10px] text-muted-foreground text-center pt-1">
        All providers support NGN · Secured by 256-bit TLS · PCI-DSS compliant
      </p>
    </div>
  );
}
