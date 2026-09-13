import { Component, type ErrorInfo, type ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Rendered instead of the default card. Receives the caught error + a reset fn. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Short label for the default fallback, e.g. "Audit". */
  title?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches render-time exceptions in a subtree and shows an inline card instead
 * of letting the error unmount the whole React root (which renders a blank
 * screen). Without this, a single thrown error anywhere in a page tree takes
 * the entire SPA down.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error("ErrorBoundary caught a render error:", error, info);
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return (
      <Card className="m-5 border-destructive/40">
        <CardContent className="py-6 space-y-3">
          <div className="text-sm font-semibold text-destructive">
            {this.props.title ? `${this.props.title} hit an error` : "Something went wrong"}
          </div>
          <p className="text-xs text-muted-foreground">
            This view ran into an unexpected error and could not render. The rest
            of the portal is unaffected.
          </p>
          {error.message && (
            <pre className="text-[11px] whitespace-pre-wrap break-words rounded bg-muted px-2 py-1.5 text-muted-foreground">
              {error.message}
            </pre>
          )}
          <Button size="sm" variant="outline" onClick={this.reset}>
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }
}
