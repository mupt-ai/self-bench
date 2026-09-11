import { ChevronRight } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "./primitives/cn";

export const pageContainer = "mx-auto w-full min-w-0 max-w-[1440px]";
export const pageGutter = "px-4 sm:px-6 lg:px-8";

export function PageFrame({ children, className, ...props }: ComponentProps<"main">) {
  return (
    <main {...props} className={cn("w-full min-w-0 flex-1 py-6 pb-12", pageGutter, className)}>
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
      className={cn("mb-6 flex min-w-0 flex-wrap items-center justify-between gap-4", className)}
      data-slot="page-header"
    >
      <div className="min-w-0">
        <h1 className="text-xl leading-7 font-medium tracking-tight text-foreground">{title}</h1>
        {description && (
          <p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p>
        )}
      </div>
      {children && (
        <div className="flex max-w-full flex-wrap items-center gap-2" data-slot="page-actions">
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
    <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-sm leading-6 font-medium text-foreground">{title}</h2>
        {description && (
          <p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
    </header>
  );
}

export function Breadcrumbs({ items }: { items: { label: string; to?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-4 min-w-0">
      <ol className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        {items.map((item, index) => (
          <li
            key={item.to ?? item.label}
            className={cn(
              "flex min-w-0 items-center gap-2",
              index === items.length - 1 ? "flex-1" : "shrink-0",
            )}
          >
            {index > 0 && <ChevronRight className="size-3 shrink-0" aria-hidden="true" />}
            {item.to ? (
              <Link to={item.to} className="truncate hover:text-foreground">
                {item.label}
              </Link>
            ) : (
              <span className="truncate" aria-current="page">
                {item.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
