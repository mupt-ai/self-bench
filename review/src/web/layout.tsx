import { ChevronRight } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "./primitives/cn";
import { InfoTooltip } from "./primitives/tooltip";

export const pageContainer = "mx-auto w-full min-w-0 max-w-6xl";
export const pageGutter = "px-4 sm:px-6";

export function PageFrame({ children, className, ...props }: ComponentProps<"main">) {
  return (
    <main {...props} className={cn("w-full min-w-0 flex-1 py-6", pageGutter, className)}>
      <div className={pageContainer}>{children}</div>
    </main>
  );
}

export function PageContent({ className, ...props }: ComponentProps<"section">) {
  return <section {...props} className={cn("w-full min-w-0", className)} />;
}

export function PageHeader({
  title,
  description,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "mb-6 flex min-w-0 flex-col gap-4 sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
      data-slot="page-header"
    >
      <div className="min-w-0">
        <Heading
          level={1}
          className="text-xl font-medium text-foreground"
          description={description}
        >
          {title}
        </Heading>
        <Metadata description={description} className="mt-1" />
      </div>
      {children && (
        <div
          className="flex w-full max-w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0"
          data-slot="page-actions"
        >
          {children}
        </div>
      )}
    </header>
  );
}

export function SectionHeader({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="mb-3 flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <Heading
          level={2}
          className="text-base leading-6 font-medium text-foreground"
          description={description}
        >
          {title}
        </Heading>
        <Metadata description={description} className="mt-0.5" />
      </div>
      {children}
    </header>
  );
}

/**
 * A heading stands alone. A sentence about it is helper text, so it goes in a tooltip beside the
 * heading; anything richer (a branch, a date, who started it) is metadata and stays on a line
 * under it.
 */
function Heading({
  level,
  className,
  description,
  children,
}: {
  level: 1 | 2;
  className: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  const Tag = level === 1 ? "h1" : "h2";
  if (typeof description !== "string" || !description)
    return <Tag className={className}>{children}</Tag>;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Tag className={className}>{children}</Tag>
      <InfoTooltip label={description} side="bottom" />
    </span>
  );
}

function Metadata({ description, className }: { description?: ReactNode; className: string }) {
  if (!description || typeof description === "string") return null;
  return <div className={cn("text-[13px] text-muted-foreground", className)}>{description}</div>;
}

export function Breadcrumbs({
  items,
}: {
  items: { label: string; to?: string; mono?: boolean }[];
}) {
  return (
    <nav aria-label="Breadcrumb" className="mb-4 min-w-0">
      <ol className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground">
        {items.map((item, index) => (
          <li
            key={item.to ?? item.label}
            className={cn(
              "flex min-w-0 items-center gap-2",
              index === items.length - 1 ? "flex-1" : "shrink-0",
            )}
          >
            {index > 0 && (
              <ChevronRight className="size-3 shrink-0 text-faint" aria-hidden="true" />
            )}
            {item.to ? (
              <Link
                to={item.to}
                className={cn(
                  "truncate transition-colors hover:text-foreground",
                  item.mono && "font-mono",
                )}
              >
                {item.label}
              </Link>
            ) : (
              <span
                className={cn("truncate text-foreground", item.mono && "font-mono")}
                aria-current="page"
              >
                {item.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
