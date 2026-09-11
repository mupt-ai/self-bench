import type { ComponentProps, ReactNode } from "react";
import { cn } from "./primitives/cn";

export function EmptyState({
  title,
  children,
  action,
  className,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-40 flex-col items-center justify-center gap-2 border border-dashed border-input bg-card/30 p-6 text-center",
        className,
      )}
    >
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      {children && (
        <div className="max-w-lg text-sm leading-6 text-muted-foreground">{children}</div>
      )}
      {action && <div className="mt-2">{action}</div>}
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
          ? "border-destructive/30 bg-destructive/5 text-destructive"
          : tone === "success"
            ? "border-success/30 bg-success/5 text-success"
            : "border-border bg-muted/30 text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}
