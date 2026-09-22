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
    <div className={cn("panel flex flex-col gap-4 p-5 text-left", className)}>
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {children && <div className="max-w-2xl text-sm text-muted-foreground">{children}</div>}
      </div>
      {action && <div className="flex flex-wrap gap-2">{action}</div>}
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
