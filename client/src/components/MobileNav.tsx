/**
 * MobileNav — bottom navigation bar for mobile PWA
 * Shown only on small screens (< md breakpoint)
 * Provides quick access to the 5 most important routes
 */
import { Link, useLocation } from "wouter";
import { Home, MapPin, Wallet, Search, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";

const NAV_ITEMS = [
  { href: "/", icon: Home, label: "Home" },
  { href: "/map", icon: MapPin, label: "Map" },
  { href: "/wallet", icon: Wallet, label: "Wallet" },
  { href: "/status", icon: Search, label: "Status" },
  { href: "/settings", icon: Settings, label: "Settings" },
];

export default function MobileNav() {
  const [location] = useLocation();
  const { isAuthenticated } = useAuth();

  // Don't show on auth pages or admin pages
  if (location.startsWith("/auth/") || location.startsWith("/portal/admin")) return null;

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 md:hidden bg-white/95 backdrop-blur-md border-t border-border safe-area-pb">
      <div className="flex items-center justify-around px-2 py-1">
        {NAV_ITEMS.map(({ href, icon: Icon, label }) => {
          const isActive = href === "/" ? location === "/" : location.startsWith(href);
          // Replace Account with wallet link if authenticated
          const actualHref = label === "Account" && isAuthenticated ? "/wallet" : href;
          const actualLabel = label === "Account" && isAuthenticated ? "Account" : label;

          return (
            <Link key={href} href={actualHref}>
              <button
                className={cn(
                  "flex flex-col items-center gap-0.5 px-3 py-2 rounded-xl transition-all min-w-[56px]",
                  isActive
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <div className={cn(
                  "w-8 h-8 rounded-xl flex items-center justify-center transition-all",
                  isActive ? "bg-primary/10" : ""
                )}>
                  <Icon className={cn("w-5 h-5", isActive && "stroke-[2.5]")} />
                </div>
                <span className={cn("text-[10px] font-medium", isActive && "font-semibold")}>
                  {actualLabel}
                </span>
              </button>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
