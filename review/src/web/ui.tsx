import { ChevronDown, Search } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "./primitives/cn";

export { Breadcrumbs, PageContent, PageFrame, PageHeader, SectionHeader } from "./layout";
export { EmptyState, Notice } from "./states";

const buttonBase =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&>svg]:shrink-0";
const buttonVariants = {
  primary: cn(
    buttonBase,
    "border border-primary bg-primary text-primary-foreground hover:bg-primary/90",
  ),
  secondary: cn(
    buttonBase,
    "border border-input bg-transparent text-foreground hover:border-foreground/40 hover:bg-accent",
  ),
  ghost: cn(buttonBase, "bg-transparent text-foreground hover:bg-accent"),
  destructive: cn(
    buttonBase,
    "border border-destructive-background bg-destructive-background text-destructive-foreground hover:bg-destructive-background/90",
  ),
};

const standaloneButtonGeometry = "h-9 gap-2 px-4 [&>svg]:size-4 [&>svg]:shrink-0";
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
        size === "default" && "h-9 px-4",
        size === "small" && "h-8 px-3 text-[13px]",
        size === "icon" && "h-9 w-9",
        className,
      )}
    />
  );
}

/** A filled tag: a model's vendor, a count, a short enum value. */
export const chipStyles =
  "inline-flex h-5 items-center rounded-sm bg-foreground/[0.07] px-1.5 text-xs text-muted-foreground";

/** A bordered state: Active, Running, Published. Add a tone's border, fill, and text. */
export const badgeStyles = "inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[11px] font-medium";

/** A row of mutually exclusive choices: the group is rounded, its segments are divided. */
export const segmentedGroupStyles =
  "inline-flex overflow-hidden rounded-md border border-input divide-x divide-border text-[13px]";
export function segmentStyles(selected: boolean, chart = false) {
  return cn(
    "px-2.5 py-1 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
    selected
      ? chart
        ? "bg-foreground text-background"
        : "bg-foreground/15 text-foreground"
      : "text-muted-foreground hover:bg-accent hover:text-foreground",
  );
}

/** An icon-only button that is not the Button primitive. */
export const iconButtonStyles =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

/** A checkbox drawn by hand: an empty rounded box, ink-filled when on. Pair with a mark in
 * `text-background` shown only when checked. Plain native checkboxes need nothing: the theme
 * gives them the same ink. */
export const checkboxStyles =
  "peer size-4 shrink-0 cursor-pointer appearance-none rounded-sm border border-foreground/30 bg-transparent transition-colors checked:border-foreground checked:bg-foreground hover:border-foreground/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

/** An inline notice: rounded, since it is not on the page's grid. */
export const noticeStyles = {
  info: "rounded-md border border-brand/40 bg-brand/10 p-3 text-sm",
  warning: "rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-warning",
  error: "rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm",
};

export const fieldStyles = "grid min-w-0 gap-2 text-[13px] font-medium text-foreground";
export const controlStyles =
  "h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-base font-normal text-foreground placeholder:text-faint transition-colors hover:border-foreground/30 focus-visible:border-ring focus-visible:outline-none! focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input {...props} className={cn(controlStyles, className)} />;
}

export function SearchInput({ className, ...props }: ComponentProps<typeof Input>) {
  return (
    <span className={cn("relative block min-w-0", className)}>
      <Search
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint"
        aria-hidden="true"
      />
      <Input type="search" {...props} className="pl-9" />
    </span>
  );
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return (
    <span className="relative block min-w-0">
      <select
        {...props}
        data-slot="select"
        className={cn(controlStyles, "truncate pr-9", className)}
      />
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-3 size-3.5 -translate-y-1/2 text-faint"
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
          "w-full border-collapse text-left text-sm [&_th]:px-4 [&_th]:py-2.5 [&_th]:text-xs [&_th]:font-medium [&_th]:whitespace-nowrap [&_th]:text-faint [&_td]:border-t [&_td]:border-border [&_td]:px-4 [&_td]:py-2.5 [&_td]:align-middle [&_tbody_tr]:transition-colors [&_tbody_tr:hover]:bg-accent [&_small]:mt-0.5 [&_small]:block [&_small]:text-xs [&_small]:text-muted-foreground",
          className,
        )}
      />
    </section>
  );
}
