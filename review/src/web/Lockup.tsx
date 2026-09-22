import { Link } from "react-router";
import { cn } from "./primitives/cn";

/** The SELF-BENCH wordmark, shared with selfbench.dev. Links home. */
export function Lockup({
  compact = false,
  showName = true,
  className,
}: {
  compact?: boolean;
  showName?: boolean;
  className?: string;
}) {
  return (
    <Link
      to="/"
      aria-label="SELF-BENCH Home"
      className={cn(
        "inline-flex min-w-0 items-center font-mono font-bold tracking-wider whitespace-nowrap text-foreground",
        compact ? "text-base" : "text-xl",
        className,
      )}
    >
      {showName ? "SELF-BENCH" : "SB"}
    </Link>
  );
}
