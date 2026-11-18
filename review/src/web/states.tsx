import type { ComponentProps, ReactNode } from "react";
import { cn } from "./primitives/cn";

/**
 * What a page shows before it has anything: what will be here, and the action that fills it. With
 * `visual`, a faint picture of the page to come (ghosts.tsx) sits beside the words, stacked below
 * them wherever the card itself is narrow, in a page or a sheet alike.
 */
export function EmptyState({
  title,
  children,
  action,
  visual,
  className,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  visual?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("panel @container text-left", className)}>
      <div className={cn("grid", visual && "@2xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]")}>
        <div className="flex flex-col justify-center p-6">
          <h3 className="text-[15px] leading-6 font-medium tracking-[-0.01em] text-foreground">
            {title}
          </h3>
          {children && (
            <div className="mt-1.5 max-w-[52ch] text-sm leading-6 text-muted-foreground">
              {children}
            </div>
          )}
          {action && <div className="mt-5 flex flex-wrap gap-2">{action}</div>}
        </div>
        {visual && (
          <div
            aria-hidden="true"
            className="flex items-center border-t border-border p-6 @2xl:border-t-0 @2xl:border-l"
          >
            <div className="w-full">{visual}</div>
          </div>
        )}
      </div>
    </div>
  );
}

export function Notice({
  tone = "error",
  className,
  children,
  ...props
}: ComponentProps<"div"> & { tone?: "error" | "success" | "info" }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      {...props}
      className={cn(
        "flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-sm leading-6",
        tone === "error"
          ? "border-destructive/50 bg-destructive/10 text-foreground"
          : "border-brand/40 bg-brand/10 text-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}
