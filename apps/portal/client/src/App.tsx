import { Switch, Route, Router, useLocation } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import OverviewPage from "@/pages/overview";
import ContainersPage from "@/pages/containers";
import AuditPage from "@/pages/audit";
import ConsentV2Page from "@/pages/consent-v2";
import ServerSidePage from "@/pages/server-side";
import RecommendPage from "@/pages/recommend";
import ApprovalsPage from "@/pages/approvals";
import ProfilePage from "@/pages/profile";
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
      <Switch>
        <Route path="/" component={OverviewPage} />
        <Route path="/containers" component={ContainersPage} />
        <Route path="/audit" component={AuditPage} />
        <Route path="/consent-v2" component={ConsentV2Page} />
        <Route path="/server-side" component={ServerSidePage} />
        <Route path="/recommend" component={RecommendPage} />
        <Route path="/approvals" component={ApprovalsPage} />
        <Route path="/profile" component={ProfilePage} />
        <Route path="/account" component={ProfilePage} />
        <Route component={NotFound} />
      </Switch>
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
