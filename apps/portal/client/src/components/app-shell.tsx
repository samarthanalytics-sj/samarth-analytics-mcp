import { Link, useLocation } from "wouter";
import { useState } from "react";
import {
  LayoutDashboard,
  Boxes,
  ClipboardCheck,
  Sparkles,
  GitPullRequest,
  Menu,
  X,
  CircleUserRound,
  ShieldCheck,
} from "lucide-react";
import { BrandLogo } from "./brand-logo";
import { Badge } from "@/components/ui/badge";
import { usePortal } from "@/lib/portal-store";
import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
}

const NAV: NavItem[] = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/containers", label: "Containers", icon: Boxes },
  { href: "/audit", label: "Audit", icon: ClipboardCheck },
  { href: "/recommend", label: "Recommendations", icon: Sparkles },
  { href: "/approvals", label: "Approvals", icon: GitPullRequest },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const { oauth } = usePortal();

  const isActive = (href: string) =>
    href === "/" ? location === "/" : location.startsWith(href);

  return (
    <div className="min-h-screen bg-background text-foreground flex">
      {/* Desktop sidebar */}
      <aside className="hidden md:flex md:flex-col w-60 shrink-0 border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
        <div className="h-16 px-5 flex items-center text-sidebar-primary">
          <BrandLogo size={26} accent="#FBBF24" />
        </div>
        <nav className="flex-1 px-3 py-3 space-y-1">
          {NAV.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                data-testid={`nav-${item.label.toLowerCase()}`}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  active
                    ? "bg-sidebar-primary text-sidebar-primary-foreground"
                    : "text-sidebar-foreground/85 hover-elevate",
                )}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="px-4 py-4 border-t border-sidebar-border text-xs">
          <div className="flex items-center gap-2">
            {oauth.connected ? (
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
            ) : (
              <CircleUserRound className="h-3.5 w-3.5 text-sidebar-foreground/60" />
            )}
            <span className="truncate text-sidebar-foreground/80" data-testid="text-auth-status">
              {oauth.connected ? oauth.email ?? "Connected" : "Google not connected"}
            </span>
          </div>
        </div>
      </aside>

      {/* Mobile header */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="md:hidden h-14 px-4 flex items-center justify-between border-b border-border bg-sidebar text-sidebar-foreground sticky top-0 z-30">
          <BrandLogo size={22} />
          <button
            type="button"
            data-testid="button-menu"
            aria-label="Open menu"
            onClick={() => setMobileOpen(true)}
            className="p-2 rounded-md hover-elevate"
          >
            <Menu className="h-5 w-5" />
          </button>
        </header>

        {/* Mobile drawer */}
        {mobileOpen && (
          <div className="fixed inset-0 z-40 md:hidden">
            <div
              className="absolute inset-0 bg-black/50"
              onClick={() => setMobileOpen(false)}
            />
            <div className="absolute inset-y-0 left-0 w-72 bg-sidebar text-sidebar-foreground p-5 flex flex-col">
              <div className="flex items-center justify-between">
                <BrandLogo size={24} />
                <button
                  type="button"
                  data-testid="button-menu-close"
                  aria-label="Close menu"
                  onClick={() => setMobileOpen(false)}
                  className="p-2 rounded-md hover-elevate"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <nav className="mt-6 space-y-1">
                {NAV.map((item) => {
                  const Icon = item.icon;
                  const active = isActive(item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setMobileOpen(false)}
                      className={cn(
                        "flex items-center gap-2.5 rounded-md px-3 py-2.5 text-sm font-medium",
                        active
                          ? "bg-sidebar-primary text-sidebar-primary-foreground"
                          : "text-sidebar-foreground/85 hover-elevate",
                      )}
                    >
                      <Icon className="h-4 w-4" />
                      {item.label}
                    </Link>
                  );
                })}
              </nav>
              <div className="mt-auto pt-4 text-xs text-sidebar-foreground/70">
                {oauth.connected ? (
                  <Badge variant="secondary" className="gap-1">
                    <ShieldCheck className="h-3 w-3" />
                    Google connected
                  </Badge>
                ) : (
                  <span>Google not connected</span>
                )}
              </div>
            </div>
          </div>
        )}

        <main className="flex-1 min-w-0">{children}</main>
      </div>
    </div>
  );
}
