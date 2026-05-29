import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import OverviewPage from "@/pages/overview";
import ContainersPage from "@/pages/containers";
import AuditPage from "@/pages/audit";
import RecommendPage from "@/pages/recommend";
import ApprovalsPage from "@/pages/approvals";
import { AppShell } from "@/components/app-shell";
import { PortalProvider } from "@/lib/portal-store";
import { ThemeProvider } from "@/lib/theme-provider";

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={OverviewPage} />
      <Route path="/containers" component={ContainersPage} />
      <Route path="/audit" component={AuditPage} />
      <Route path="/recommend" component={RecommendPage} />
      <Route path="/approvals" component={ApprovalsPage} />
      <Route component={NotFound} />
    </Switch>
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
