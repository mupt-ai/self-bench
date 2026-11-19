import type React from "react";

/** One collapsible row of the agent work sheet: an agent run or a verification. */
export function WorkPart({
  title,
  status,
  capturedAt,
  children,
}: {
  title: string;
  status: string;
  capturedAt?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <details className="group/part panel">
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-x-2 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden sm:px-4">
        <span
          aria-hidden="true"
          className="shrink-0 text-[11px] text-muted-foreground before:content-['▸'] group-open/part:before:content-['▾']"
        />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{title}</span>
        <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">{status}</span>
      </summary>
      <div className="border-t border-border">
        {capturedAt && (
          <p className="m-0 border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground sm:px-4">
            Updated {formatCapturedAt(capturedAt)}
          </p>
        )}
        {children}
      </div>
    </details>
  );
}

function formatCapturedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}
