import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export interface SelectorOption {
  value: string;
  label: string;
}

/**
 * A single labelled dropdown in the account → container → workspace cascade,
 * with loading, error (+ optional reconnect), and empty states.
 *
 * Radix <SelectItem> throws on an empty-string value, so options whose `value`
 * is falsy are dropped — a malformed API row can't crash the page.
 */
export function SelectorBlock({
  label,
  value,
  onChange,
  options,
  placeholder,
  loading,
  error,
  disabled,
  testId,
  onReconnect,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: SelectorOption[];
  placeholder: string;
  loading?: boolean;
  error?: (Error & { status?: number }) | null;
  disabled?: boolean;
  testId?: string;
  onReconnect?: () => void;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">
        {label}
      </div>
      <Select value={value} onValueChange={onChange} disabled={disabled || loading}>
        <SelectTrigger data-testid={testId}>
          <SelectValue placeholder={loading ? "Loading…" : placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options
            .filter((o) => Boolean(o.value))
            .map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
      {error && (
        <div className="mt-1 space-y-1">
          <div className="text-[11px] text-destructive break-words">{error.message}</div>
          {error.status === 401 && onReconnect && (
            <Button variant="outline" size="sm" className="h-6 text-[11px]" onClick={onReconnect}>
              Reconnect Google
            </Button>
          )}
        </div>
      )}
      {!error && !loading && options.length === 0 && !disabled && (
        <div className="mt-1 text-[11px] text-muted-foreground">None available.</div>
      )}
    </div>
  );
}

/** A small labelled metric card with an icon and an optional loading skeleton. */
export function StatCard({
  label,
  value,
  icon: Icon,
  loading,
}: {
  label: string;
  value?: number;
  icon: React.ComponentType<{ className?: string }>;
  loading?: boolean;
}) {
  return (
    <Card>
      <CardContent className="py-3.5 md:py-4">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground">
          <Icon className="h-3.5 w-3.5 text-primary" />
          {label}
        </div>
        <div className="mt-2 font-mono text-xl tabular-nums">
          {loading ? <Skeleton className="h-6 w-12" /> : value ?? 0}
        </div>
      </CardContent>
    </Card>
  );
}
