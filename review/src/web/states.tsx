import type { ComponentProps, ReactNode } from "react";
import { cn } from "./primitives/cn";

/**
 * What a page shows before it has anything: what will be here, and the action that fills it. With
 * `visual`, a faint picture of the page to come sits beside the words, stacked below them on a
 * narrow screen.
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
    <div
      className={cn(
        "panel grid text-left",
        visual && "md:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]",
        className,
      )}
    >
      <div className="flex flex-col justify-center p-6 sm:p-8">
        <h3 className="text-lg leading-7 font-semibold tracking-tight text-foreground">{title}</h3>
        {children && (
          <div className="mt-2 max-w-[52ch] text-sm leading-6 text-muted-foreground">
            {children}
          </div>
        )}
        {action && <div className="mt-6 flex flex-wrap gap-2.5">{action}</div>}
      </div>
      {visual && (
        <div aria-hidden="true" className="border-t border-border p-6 md:border-t-0 md:border-l">
          {visual}
        </div>
      )}
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
        "flex min-w-0 flex-wrap items-center justify-between gap-3 border px-4 py-3 text-sm leading-6",
        tone === "error"
          ? "border-destructive/30 bg-destructive/[0.06] text-destructive"
          : tone === "success"
            ? "border-success/30 bg-success/[0.06] text-success"
            : "border-border bg-muted/60 text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}
