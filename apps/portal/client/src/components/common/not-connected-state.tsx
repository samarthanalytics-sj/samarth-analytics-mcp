import { PlugZap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StateCard } from "@/components/common/state-card";
import { portalApi } from "@/lib/portal-api";
import type { OAuthState } from "@shared/portal-types";

/**
 * The "Connect Google Tag Manager" gate shown on every authenticated page
 * before OAuth completes. Previously copy-pasted (with subtle drift) into
 * audit, consent-v2, containers and server-side. Centralising it keeps the
 * connect flow, the not-configured warning and the data-testids consistent.
 *
 * `oauth.configured === false` means the portal backend has no Google client
 * credentials, so connecting is impossible — we show the admin notice instead
 * of a dead button.
 */
export function NotConnectedState({
  oauth,
  title,
  description,
  connectLabel = "Connect Google Tag Manager",
  testId,
}: {
  oauth: OAuthState;
  title: string;
  description: React.ReactNode;
  connectLabel?: string;
  /** data-testid for the connect button (e.g. "button-audit-connect-google"). */
  testId?: string;
}) {
  const notConfigured = oauth.configured === false;
  return (
    <StateCard
      icon={PlugZap}
      tone="primary"
      title={title}
      description={description}
      actions={
        notConfigured ? undefined : (
          <Button
            size="lg"
            className="min-h-11"
            onClick={() => portalApi.redirectToGoogleOAuth()}
            data-testid={testId}
          >
            {connectLabel}
          </Button>
        )
      }
    >
      {notConfigured && (
        <p className="text-xs text-amber-600 dark:text-amber-400 max-w-md mx-auto">
          {oauth.message ??
            "Google OAuth credentials are not configured on this portal. Ask your administrator to set them up."}
        </p>
      )}
    </StateCard>
  );
}
