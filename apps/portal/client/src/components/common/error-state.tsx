import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { portalApi } from "@/lib/portal-api";

/**
 * The destructive-bordered card shown when a mutation/query fails, with an
 * optional "Reconnect Google" affordance for 401/scope errors. Consolidates
 * the per-page error cards in audit, consent-v2 and server-side.
 *
 * `role="alert"` so the failure is announced immediately to screen readers.
 */
export function ErrorState({
  title,
  message,
  showReconnect = false,
  onReconnect = () => portalApi.redirectToGoogleOAuth(),
  className = "mt-5",
  testId,
}: {
  title: string;
  message?: string;
  showReconnect?: boolean;
  onReconnect?: () => void;
  className?: string;
  testId?: string;
}) {
  return (
    <Card className={`border-destructive/40 ${className}`} data-testid={testId}>
      <CardContent className="py-4 text-sm text-destructive" role="alert">
        <div className="font-medium mb-1">{title}</div>
        {message && <div className="text-xs break-words">{message}</div>}
        {showReconnect && (
          <Button
            variant="outline"
            size="sm"
            className="mt-3 min-h-9"
            onClick={onReconnect}
          >
            Reconnect Google
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The amber "some reads failed — results may be incomplete" banner that audit,
 * consent-v2 and server-side each rendered inline. Honest partial-failure
 * surfacing is a product guarantee here, so it gets a shared, consistent home.
 */
export function ToolFailureList({
  title,
  failures,
  className = "",
  testId,
}: {
  title: string;
  failures: { resource: string; message: string; status?: number }[];
  className?: string;
  testId?: string;
}) {
  if (failures.length === 0) return null;
  return (
    <div
      role="alert"
      data-testid={testId}
      className={`text-[11px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200/60 dark:border-amber-800/40 rounded p-2 ${className}`}
    >
      <div className="font-medium mb-1">{title}</div>
      <ul className="list-disc ml-4 space-y-0.5">
        {failures.map((tf, i) => (
          <li key={`${tf.resource}-${i}`}>
            <span className="font-mono">{tf.resource}</span>: {tf.message}
            {typeof tf.status === "number" ? ` (${tf.status})` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}
