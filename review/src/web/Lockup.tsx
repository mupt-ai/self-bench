import { clsx } from "clsx";
import { Link } from "react-router";

/** The dari turtle mark, as shipped in the approved login mock. */
function DariMark() {
  return (
    <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <g fill="currentColor">
        <path d="M227.174 643.267C309.13 501.04 353.3 382.247 461.711 379.747c100.278 6.927 172.975 162.686 217.376 263.52h110.942c-81.304-117.797-196.325-301.555-326.906-303.36-166.044-4.954-236.495 312.426-235.949 303.36" />
        <path d="M657.933 552.765h177.78V487.33l-224.079 18.712 44.162 15.727zM327.444 446.849h14.02v89.346h-14.02z" />
        <path d="M368.884 403.285h13.92v129.377h-13.92z" />
        <path d="M413.178 382.234h13.886v144.712h-13.886zm48.935-4.033h13.886v144.712h-13.886z" />
        <path d="M525.783 410.11h.44v-.31h-.44zm-13.447.421v118.442h13.887V423.498a300 300 0 0 0-13.887-12.967" />
        <path d="m593.563 507.768-329.946 33.841-85.683 11.157h444.87c-9.563-15.205-19.29-30.327-29.241-44.998" />
      </g>
    </svg>
  );
}

/** The dari mark beside "self-bench" over "by dari.dev". Links home. */
export function Lockup({
  compact = false,
  showName = true,
  className,
  href,
  onClick,
}: {
  compact?: boolean;
  showName?: boolean;
  className?: string;
  href?: string;
  onClick?: React.MouseEventHandler<HTMLAnchorElement>;
}) {
  const content = (
    <>
      <span
        className={
          compact
            ? "inline-flex size-7 shrink-0 items-center justify-center rounded-full border border-foreground/30 text-foreground [&>svg]:size-5"
            : "size-9 shrink-0 translate-y-1 text-foreground"
        }
      >
        <DariMark />
      </span>
      {showName && (
        <span className="flex min-w-0 flex-col gap-0.5">
          <strong
            className={clsx("font-mono font-bold tracking-wide", compact ? "text-base" : "text-lg")}
          >
            self-bench
          </strong>
          <span className="font-mono text-xs leading-none text-muted-foreground">by dari.dev</span>
        </span>
      )}
    </>
  );
  // Plain joining, not `cn`: selfbench.dev shows this logo too, and nothing here needs
  // tailwind-merge, which would otherwise ship in its bundle for this alone.
  const classNames = clsx("inline-flex min-w-0 items-center gap-2.5 text-foreground", className);

  if (href) {
    return (
      <a
        className={classNames}
        href={href}
        aria-label="self-bench by dari.dev Home"
        onClick={onClick}
      >
        {content}
      </a>
    );
  }

  return (
    <Link className={classNames} to="/" aria-label="self-bench by dari.dev Home" onClick={onClick}>
      {content}
    </Link>
  );
}
