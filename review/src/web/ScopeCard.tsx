import { Ellipsis, Plus } from "lucide-react";
import { type ReactNode, useRef } from "react";
import { Link } from "react-router";
import { Skeleton } from "./LoadingSkeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./primitives/dropdown-menu";
import { Button } from "./ui";

export interface ScopeStat {
  label: string;
  /** Undefined while it loads. */
  value?: number | string;
  attention?: boolean;
}

/**
 * A repository's or benchmark's box in its list: the whole box opens it, its menu removes it, and
 * three figures sit along the bottom.
 */
export function ScopeCard({
  name,
  to,
  icon,
  details,
  stats,
  removeLabel,
  onRemove,
  notice,
}: {
  /** `owner/name`, as the box is titled. */
  name: string;
  /** Where the box opens; a box with nothing to open yet (still being added) has none. */
  to?: string;
  icon: ReactNode;
  /** The line under the title, as its parts. */
  details: readonly ReactNode[];
  stats: readonly ScopeStat[];
  /** The menu's one item, such as Disconnect or Remove. */
  removeLabel: string;
  onRemove(): void;
  /** Why the box can't be used, such as an add that failed, shown under its details. */
  notice?: ReactNode;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const pendingRemove = useRef(false);
  return (
    <article className="panel group relative flex h-full min-h-40 flex-col transition-[border-color,box-shadow] hover:border-foreground/30 hover:shadow-[0_2px_4px_rgb(0_0_0/0.06),0_10px_24px_-8px_rgb(0_0_0/0.14)] has-[a:focus-visible]:border-foreground/40">
      {to && (
        <Link
          aria-label={`Open ${name}`}
          className="absolute inset-0 z-0 focus-visible:outline-none!"
          to={to}
        />
      )}
      <header className="pointer-events-none relative z-10 flex items-center gap-2.5 px-4 pt-4">
        {icon}
        <h2 className="min-w-0 flex-1 truncate font-mono text-sm font-medium">{name}</h2>
        <DropdownMenu
          onOpenChange={(open) => {
            if (open) pendingRemove.current = false;
          }}
        >
          <DropdownMenuTrigger asChild>
            <Button
              ref={trigger}
              size="icon"
              variant="ghost"
              className="pointer-events-auto -my-1 -mr-2 h-8 w-8 text-muted-foreground hover:text-foreground"
              aria-label={`Actions for ${name}`}
            >
              <Ellipsis aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            onCloseAutoFocus={(event) => {
              // Confirming happens once the menu has closed and focus is back on its trigger.
              if (!pendingRemove.current) return;
              event.preventDefault();
              pendingRemove.current = false;
              trigger.current?.focus();
              onRemove();
            }}
          >
            <DropdownMenuItem
              className="text-destructive data-[highlighted]:text-destructive"
              onSelect={() => {
                pendingRemove.current = true;
              }}
            >
              {removeLabel}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      <p className="pointer-events-none relative z-10 mt-2 flex items-center gap-x-2 truncate px-4 text-xs text-muted-foreground">
        {details.map((detail, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts never reorder.
          <span key={index} className="contents">
            {index > 0 && <span aria-hidden="true">·</span>}
            {detail}
          </span>
        ))}
      </p>
      {notice && (
        <p role="alert" className="relative z-10 mt-2 line-clamp-3 px-4 text-xs text-destructive">
          {notice}
        </p>
      )}
      <dl className="pointer-events-none relative z-10 mt-auto grid grid-cols-3 border-t border-border">
        {stats.map((stat) => (
          <Stat key={stat.label} {...stat} />
        ))}
      </dl>
    </article>
  );
}

function Stat({ label, value, attention }: ScopeStat) {
  return (
    <div className="flex min-w-0 flex-col gap-1 border-r border-border px-4 py-3 last:border-r-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate font-mono text-sm font-medium tabular-nums">
        {value === undefined ? (
          <Skeleton className="inline-block h-3.5 w-8 align-middle" />
        ) : (
          <span className={attention ? "text-brand-foreground" : "text-foreground"}>{value}</span>
        )}
      </dd>
    </div>
  );
}

/** The dashed box after a list's last, which adds another. */
export function AddScopeButton({ label, onClick }: { label: string; onClick(): void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="group flex h-full min-h-40 w-full flex-col items-center justify-center gap-2 border-[1.5px] border-dashed border-foreground/15 text-sm font-semibold text-muted-foreground transition-colors hover:border-foreground/35 hover:bg-foreground/[0.03] hover:text-foreground"
    >
      <Plus className="size-5" aria-hidden="true" />
      {label}
    </button>
  );
}
