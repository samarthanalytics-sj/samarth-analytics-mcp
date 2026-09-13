import { useState } from "react";
import {
  CircleUserRound,
  ShieldCheck,
  ShieldAlert,
  LogOut,
  RefreshCw,
  ExternalLink,
} from "lucide-react";
import { PageBody, PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { portalApi } from "@/lib/portal-api";
import { usePortal } from "@/lib/portal-store";
import { useToast } from "@/hooks/use-toast";

function initialsFor(name?: string | null, email?: string | null): string {
  const source = (name || email || "").trim();
  if (!source) return "G";
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return source.slice(0, 1).toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function ProfilePage() {
  const { oauth, disconnect } = usePortal();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const handleDisconnect = async () => {
    setBusy(true);
    try {
      await disconnect();
      toast({
        title: "Google disconnected",
        description:
          "Your Google account has been disconnected from the portal. Selected GTM data has been cleared.",
      });
    } catch (e) {
      toast({
        title: "Could not disconnect",
        description:
          e instanceof Error ? e.message : "Something went wrong while signing out.",
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  const handleConnect = () => {
    if (oauth.configured === false) {
      toast({
        title: "OAuth not configured",
        description:
          oauth.message ??
          "The portal administrator must configure Google OAuth credentials before sign-in is available.",
        variant: "destructive",
      });
      return;
    }
    portalApi.redirectToGoogleOAuth();
  };

  const initials = initialsFor(oauth.userName, oauth.email);
  const expiresLabel = (() => {
    if (!oauth.expiresAt) return null;
    try {
      return new Date(oauth.expiresAt).toLocaleString();
    } catch {
      return oauth.expiresAt;
    }
  })();

  return (
    <>
      <PageHeader
        eyebrow="Account"
        title="Profile"
        description="Manage the Google account connected to the Samarth GTM Portal."
      />
      <PageBody>
        <div className="grid gap-4 md:gap-6 md:grid-cols-3">
          <Card className="md:col-span-2">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                <CircleUserRound className="h-4 w-4 text-primary" />
                Google connection
              </CardTitle>
            </CardHeader>
            <CardContent>
              {oauth.connected ? (
                <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:gap-6">
                  <Avatar className="h-16 w-16 shrink-0">
                    {oauth.picture ? (
                      <AvatarImage
                        src={oauth.picture}
                        alt={oauth.userName ?? oauth.email ?? "Profile"}
                        referrerPolicy="no-referrer"
                      />
                    ) : null}
                    <AvatarFallback className="text-base font-semibold">
                      {initials}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1 space-y-3">
                    <div>
                      <div
                        className="text-base font-semibold truncate"
                        data-testid="text-profile-name"
                      >
                        {oauth.userName ?? oauth.email ?? "Connected Google user"}
                      </div>
                      {oauth.email ? (
                        <div
                          className="text-sm text-muted-foreground truncate"
                          data-testid="text-profile-email"
                        >
                          {oauth.email}
                        </div>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary" className="gap-1">
                        <ShieldCheck className="h-3 w-3 text-emerald-500" />
                        Connected
                      </Badge>
                      {expiresLabel ? (
                        <span className="text-xs text-muted-foreground">
                          Access token refreshes after {expiresLabel}
                        </span>
                      ) : null}
                    </div>
                    {Array.isArray(oauth.scopes) && oauth.scopes.length > 0 ? (
                      <div>
                        <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">
                          Granted scopes
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {oauth.scopes.map((s) => (
                            <code
                              key={s}
                              className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground"
                            >
                              {s.replace("https://www.googleapis.com/auth/", "")}
                            </code>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-start gap-3">
                    <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center text-muted-foreground">
                      <CircleUserRound className="h-5 w-5" />
                    </div>
                    <div>
                      <div className="text-sm font-semibold">No Google account connected</div>
                      <p className="text-sm text-muted-foreground mt-0.5 max-w-md">
                        Connect a Google account that has access to your Google Tag Manager
                        containers to start auditing and building change plans.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold">Actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2.5">
              {oauth.connected ? (
                <>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="w-full justify-start gap-2"
                    onClick={handleDisconnect}
                    disabled={busy}
                    data-testid="button-disconnect-google"
                  >
                    <LogOut className="h-4 w-4" />
                    {busy ? "Disconnecting…" : "Disconnect Google"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full justify-start gap-2"
                    onClick={async () => {
                      await disconnect();
                      portalApi.redirectToGoogleOAuth();
                    }}
                    disabled={busy}
                    data-testid="button-switch-google-account"
                  >
                    <RefreshCw className="h-4 w-4" />
                    Connect a different Google account
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  className="w-full justify-start gap-2"
                  onClick={handleConnect}
                  disabled={oauth.configured === false}
                  data-testid="button-connect-google-profile"
                >
                  <ShieldCheck className="h-4 w-4" />
                  {oauth.configured === false
                    ? "OAuth not configured"
                    : "Connect Google account"}
                </Button>
              )}
              <a
                href="https://myaccount.google.com/permissions"
                target="_blank"
                rel="noreferrer noopener"
                className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 mt-1"
              >
                Manage app permissions in Google
                <ExternalLink className="h-3 w-3" />
              </a>
            </CardContent>
          </Card>
        </div>

        {!oauth.connected && oauth.configured === false ? (
          <Card className="mt-4 border-amber-500/30 bg-amber-500/5">
            <CardContent className="py-3.5 flex items-start gap-2 text-sm">
              <ShieldAlert className="h-4 w-4 mt-0.5 text-amber-600 dark:text-amber-400 shrink-0" />
              <span className="text-muted-foreground">
                {oauth.message ??
                  "Google OAuth is not configured on this portal yet. Ask your administrator to set the OAuth client environment variables."}
              </span>
            </CardContent>
          </Card>
        ) : null}
      </PageBody>
    </>
  );
}
