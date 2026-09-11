import { Search } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "./primitives/cn";

export { Breadcrumbs, PageContent, PageFrame, PageHeader, SectionHeader } from "./layout";
export { EmptyState, Notice } from "./states";

const buttonBase =
  "inline-flex h-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap border px-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:pointer-events-none disabled:opacity-40 [&>svg]:size-4 [&>svg]:shrink-0";
export const buttonStyles = {
  primary: cn(buttonBase, "border-primary bg-primary text-primary-foreground hover:bg-primary/90"),
  secondary: cn(buttonBase, "border-input bg-transparent text-foreground hover:bg-accent"),
  ghost: cn(
    buttonBase,
    "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
  ),
  destructive: cn(
    buttonBase,
    "border-destructive/50 text-destructive hover:border-destructive hover:bg-destructive/10",
  ),
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
        buttonStyles[variant],
        size === "small" && "h-8 px-2 text-xs",
        size === "icon" && "size-9 p-0",
        className,
      )}
    />
  );
}

export const fieldStyles = "grid min-w-0 gap-2 text-sm font-medium text-foreground";
export const controlStyles =
  "h-9 w-full min-w-0 rounded-none border border-input bg-background px-3 text-base text-foreground placeholder:text-muted-foreground transition-colors hover:border-foreground/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-40 md:text-sm";

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

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      {...props}
      className={cn(controlStyles, "h-auto min-h-24 resize-y py-2 leading-6", className)}
    />
  );
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return (
    <span className="relative block min-w-0">
      <select {...props} className={cn(controlStyles, "appearance-none pr-9", className)} />
      <svg
        aria-hidden="true"
        viewBox="0 0 12 12"
        className="pointer-events-none absolute top-1/2 right-3 size-3 -translate-y-1/2 fill-none stroke-muted-foreground"
        strokeWidth="1.25"
      >
        <path d="m3 4.5 3 3 3-3" />
      </svg>
    </span>
  );
}

export function DataTable({ className, ...props }: ComponentProps<"table">) {
  return (
    <section
      className="min-w-0 overflow-x-auto border border-border bg-card"
      aria-label="Scrollable Table"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll wide tables.
      tabIndex={0}
    >
      <table
        {...props}
        className={cn(
          "w-full border-collapse text-left text-sm [&_thead]:bg-muted/50 [&_th]:px-4 [&_th]:py-3 [&_th]:text-xs [&_th]:font-medium [&_th]:tracking-wider [&_th]:whitespace-nowrap [&_th]:text-muted-foreground [&_th]:uppercase [&_td]:border-t [&_td]:border-border [&_td]:px-4 [&_td]:py-3 [&_td]:align-middle [&_tbody_tr]:transition-colors [&_tbody_tr:hover]:bg-muted/50 [&_small]:mt-1 [&_small]:block [&_small]:text-xs [&_small]:text-muted-foreground",
          className,
        )}
      />
    </section>
  );
}

export function RunStatus({ value }: { value: string }) {
  const color =
    value === "completed"
      ? "text-success"
      : value === "failed"
        ? "text-destructive"
        : value === "running"
          ? "text-brand"
          : "text-muted-foreground";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs uppercase before:size-1 before:bg-current",
        color,
      )}
    >
      {value}
    </span>
  );
}
