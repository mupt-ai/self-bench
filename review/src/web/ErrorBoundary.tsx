import { Component, type ReactNode } from "react";
import { Button } from "./ui";

/** Keep a render crash from replacing the whole app with a blank root. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-medium">Something Went Wrong</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The last action crashed this view. Reload to continue.
        </p>
        <pre className="mt-4 max-h-64 overflow-auto border border-border bg-card p-4 text-xs text-destructive wrap-anywhere whitespace-pre-wrap">
          {this.state.error.message}
        </pre>
        <Button className="mt-4" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </main>
    );
  }
}
