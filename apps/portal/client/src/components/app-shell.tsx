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
  UserCircle2,
  ServerCog,
} from "lucide-react";
import { BrandLogo } from "./brand-logo";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { usePortal } from "@/lib/portal-store";
import { cn } from "@/lib/utils";

function initialsFor(name?: string, email?: string): string {
  const source = (name || email || "").trim();
  if (!source) return "G";
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return source.slice(0, 1).toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
}

const NAV: NavItem[] = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/containers", label: "Containers", icon: Boxes },
  { href: "/audit", label: "Audit", icon: ClipboardCheck },
  { href: "/server-side", label: "Server-side", icon: ServerCog },
  { href: "/recommend", label: "Recommendations", icon: Sparkles },
  { href: "/approvals", label: "Approvals", icon: GitPullRequest },
  { href: "/profile", label: "Profile", icon: UserCircle2 },
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
        <div className="px-3 py-3 border-t border-sidebar-border">
          <Link
            href="/profile"
            data-testid="link-user-chip"
            className={cn(
              "flex items-center gap-2.5 rounded-md px-2 py-2 text-xs transition-colors",
              isActive("/profile")
                ? "bg-sidebar-primary text-sidebar-primary-foreground"
                : "text-sidebar-foreground/85 hover-elevate",
            )}
          >
            <Avatar className="h-7 w-7 shrink-0">
              {oauth.connected && oauth.picture ? (
                <AvatarImage
                  src={oauth.picture}
                  alt={oauth.userName ?? oauth.email ?? "Profile"}
                  referrerPolicy="no-referrer"
                />
              ) : null}
              <AvatarFallback className="text-[10px] font-semibold bg-sidebar-accent text-sidebar-accent-foreground">
                {oauth.connected ? initialsFor(oauth.userName, oauth.email) : "•"}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                {oauth.connected ? (
                  <ShieldCheck className="h-3 w-3 text-emerald-400 shrink-0" />
                ) : (
                  <CircleUserRound className="h-3 w-3 text-sidebar-foreground/60 shrink-0" />
                )}
                <span
                  className="truncate font-medium"
                  data-testid="text-auth-status"
                >
                  {oauth.connected
                    ? oauth.userName ?? oauth.email ?? "Connected"
                    : "Sign in"}
                </span>
              </div>
              {oauth.connected && oauth.userName && oauth.email ? (
                <div className="truncate text-[11px] text-sidebar-foreground/60">
                  {oauth.email}
                </div>
              ) : null}
              {!oauth.connected ? (
                <div className="truncate text-[11px] text-sidebar-foreground/60">
                  Google not connected
                </div>
              ) : null}
            </div>
          </Link>
        </div>
      </aside>

      {/* Mobile header */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="md:hidden h-14 px-4 flex items-center justify-between border-b border-border bg-sidebar text-sidebar-foreground sticky top-0 z-30">
          <BrandLogo size={22} />
          <div className="flex items-center gap-1">
            <Link
              href="/profile"
              data-testid="link-user-chip-mobile"
              aria-label="Open profile"
              className="p-1.5 rounded-md hover-elevate"
            >
              <Avatar className="h-7 w-7">
                {oauth.connected && oauth.picture ? (
                  <AvatarImage
                    src={oauth.picture}
                    alt={oauth.userName ?? oauth.email ?? "Profile"}
                    referrerPolicy="no-referrer"
                  />
                ) : null}
                <AvatarFallback className="text-[10px] font-semibold bg-sidebar-accent text-sidebar-accent-foreground">
                  {oauth.connected ? initialsFor(oauth.userName, oauth.email) : "•"}
                </AvatarFallback>
              </Avatar>
            </Link>
            <button
              type="button"
              data-testid="button-menu"
              aria-label="Open menu"
              onClick={() => setMobileOpen(true)}
              className="p-2 rounded-md hover-elevate"
            >
              <Menu className="h-5 w-5" />
            </button>
          </div>
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
              <Link
                href="/profile"
                onClick={() => setMobileOpen(false)}
                className="mt-auto pt-4 flex items-center gap-2.5 text-xs text-sidebar-foreground/80 hover:text-sidebar-foreground"
              >
                <Avatar className="h-8 w-8">
                  {oauth.connected && oauth.picture ? (
                    <AvatarImage
                      src={oauth.picture}
                      alt={oauth.userName ?? oauth.email ?? "Profile"}
                      referrerPolicy="no-referrer"
                    />
                  ) : null}
                  <AvatarFallback className="text-[10px] font-semibold bg-sidebar-accent text-sidebar-accent-foreground">
                    {oauth.connected ? initialsFor(oauth.userName, oauth.email) : "•"}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  {oauth.connected ? (
                    <>
                      <div className="truncate font-medium text-sidebar-foreground">
                        {oauth.userName ?? oauth.email ?? "Connected"}
                      </div>
                      <div className="truncate text-[11px] text-sidebar-foreground/60">
                        {oauth.email ?? "Google connected"}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="truncate font-medium text-sidebar-foreground">
                        Sign in
                      </div>
                      <div className="truncate text-[11px] text-sidebar-foreground/60">
                        Google not connected
                      </div>
                    </>
                  )}
                </div>
                {oauth.connected ? (
                  <Badge variant="secondary" className="gap-1 shrink-0">
                    <ShieldCheck className="h-3 w-3" />
                    Connected
                  </Badge>
                ) : null}
              </Link>
            </div>
          </div>
        )}

        <main className="flex-1 min-w-0">{children}</main>
      </div>
    </div>
  );
}
