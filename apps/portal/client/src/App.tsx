import { lazy, Suspense } from "react";
import { Switch, Route, Router, useLocation } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Loader2 } from "lucide-react";

// Route pages are code-split so the initial bundle no longer carries every
// page (audit + consent-v2 + server-side alone are ~3,400 lines). Each page is
// fetched on first navigation; React Query and the app shell keep the app
// responsive while the chunk loads.
const NotFound = lazy(() => import("@/pages/not-found"));
const OverviewPage = lazy(() => import("@/pages/overview"));
const ContainersPage = lazy(() => import("@/pages/containers"));
const AuditPage = lazy(() => import("@/pages/audit"));
const ConsentV2Page = lazy(() => import("@/pages/consent-v2"));
const WebAuditPage = lazy(() => import("@/pages/web-audit"));
const ServerSidePage = lazy(() => import("@/pages/server-side"));
const RecommendPage = lazy(() => import("@/pages/recommend"));
const ApprovalsPage = lazy(() => import("@/pages/approvals"));
const ProfilePage = lazy(() => import("@/pages/profile"));
import { AppShell } from "@/components/app-shell";
import { ErrorBoundary } from "@/components/error-boundary";
import { PortalProvider } from "@/lib/portal-store";
import { ThemeProvider } from "@/lib/theme-provider";

function AppRouter() {
  // Key the boundary on the route so navigating to another page clears a
  // previously-caught render error instead of stranding the user on it.
  const [location] = useLocation();
  return (
    <ErrorBoundary key={location} title="This page">
      <Suspense
        fallback={
          <div className="flex items-center justify-center py-24 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        }
      >
        <Switch>
          <Route path="/" component={OverviewPage} />
          <Route path="/containers" component={ContainersPage} />
          <Route path="/audit" component={AuditPage} />
          <Route path="/consent-v2" component={ConsentV2Page} />
          <Route path="/web-audit" component={WebAuditPage} />
          <Route path="/server-side" component={ServerSidePage} />
          <Route path="/recommend" component={RecommendPage} />
          <Route path="/approvals" component={ApprovalsPage} />
          <Route path="/profile" component={ProfilePage} />
          <Route path="/account" component={ProfilePage} />
          <Route component={NotFound} />
        </Switch>
      </Suspense>
    </ErrorBoundary>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <PortalProvider>
          <TooltipProvider>
            <Toaster />
            <Router hook={useHashLocation}>
              <AppShell>
                <AppRouter />
              </AppShell>
            </Router>
          </TooltipProvider>
        </PortalProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
