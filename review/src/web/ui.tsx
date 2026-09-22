import { ChevronDown, Search } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "./primitives/cn";

export { Breadcrumbs, PageContent, PageFrame, PageHeader, SectionHeader } from "./layout";
export { EmptyState, Notice } from "./states";

const buttonBase =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-semibold transition-colors disabled:pointer-events-none disabled:opacity-50 [&>svg]:shrink-0";
const buttonVariants = {
  primary: cn(
    buttonBase,
    "border border-primary bg-primary text-primary-foreground hover:bg-primary/85",
  ),
  secondary: cn(
    buttonBase,
    "border border-foreground/20 bg-card text-foreground hover:border-foreground/35 hover:bg-accent",
  ),
  ghost: cn(buttonBase, "bg-transparent text-foreground hover:bg-foreground/[0.06]"),
  destructive: cn(
    buttonBase,
    "border border-destructive-background bg-destructive-background text-destructive-foreground hover:bg-destructive-background/90",
  ),
};

const standaloneButtonGeometry = "h-9 gap-2 px-3 py-2 [&>svg]:size-4 [&>svg]:shrink-0";
export const buttonStyles = {
  primary: cn(buttonVariants.primary, standaloneButtonGeometry),
  secondary: cn(buttonVariants.secondary, standaloneButtonGeometry),
  ghost: cn(buttonVariants.ghost, standaloneButtonGeometry),
  destructive: cn(buttonVariants.destructive, standaloneButtonGeometry),
};

export function Button({
  variant = "secondary",
  size = "default",
  className,
  type = "button",
  ...props
}: ComponentProps<"button"> & {
  variant?: keyof typeof buttonStyles;
  size?: "default" | "small" | "icon";
}) {
  return (
    <button
      type={type}
      {...props}
      className={cn(
        buttonVariants[variant],
        size === "default" && "h-9 px-3 py-2",
        size === "small" && "h-8 px-3 text-xs",
        size === "icon" && "h-9 w-9",
        className,
      )}
    />
  );
}

export const fieldStyles = "grid min-w-0 gap-2 text-sm font-semibold text-foreground";
export const controlStyles =
  "h-9 w-full min-w-0 rounded-none border border-input bg-card px-3 text-base font-normal text-foreground placeholder:text-muted-foreground transition-colors hover:border-foreground/30 focus-visible:border-foreground/50 focus-visible:outline-none! focus-visible:ring-2 focus-visible:ring-foreground/10 disabled:cursor-not-allowed disabled:opacity-40 md:text-sm";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input {...props} className={cn(controlStyles, className)} />;
}

export function SearchInput({ className, ...props }: ComponentProps<typeof Input>) {
  return (
    <span className={cn("relative block min-w-0", className)}>
      <Search
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <Input type="search" {...props} className="pl-9" />
    </span>
  );
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return (
    <span className="relative block min-w-0">
      <select {...props} className={cn(controlStyles, "appearance-none pr-9", className)} />
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-3 size-3.5 -translate-y-1/2 text-muted-foreground"
      />
    </span>
  );
}

export function DataTable({ className, ...props }: ComponentProps<"table">) {
  return (
    <section
      className="panel min-w-0 overflow-x-auto"
      aria-label="Scrollable Table"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll wide tables.
      tabIndex={0}
    >
      <table
        {...props}
        className={cn(
          "w-full border-collapse text-left text-sm [&_thead]:bg-muted [&_th]:px-4 [&_th]:py-2.5 [&_th]:text-xs [&_th]:font-semibold [&_th]:whitespace-nowrap [&_th]:text-muted-foreground [&_td]:border-t [&_td]:border-border [&_td]:px-4 [&_td]:py-3 [&_td]:align-middle [&_tbody_tr]:transition-colors [&_tbody_tr:hover]:bg-muted/60 [&_small]:mt-1 [&_small]:block [&_small]:text-xs [&_small]:text-muted-foreground",
          className,
        )}
      />
    </section>
  );
}

const runStatusLabels: Record<string, string> = {
  queued: "Queued",
  pending: "Pending",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  canceled: "Cancelled",
};

export function RunStatus({ value }: { value: string }) {
  const color =
    value === "completed"
      ? "text-success"
      : value === "failed"
        ? "text-destructive"
        : value === "running"
          ? "text-brand-foreground"
          : "text-muted-foreground";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs font-semibold before:size-1.5 before:rounded-full before:bg-current",
        color,
      )}
    >
      {runStatusLabels[value] ?? value}
    </span>
  );
}
