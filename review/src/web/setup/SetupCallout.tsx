import { ArrowRight } from "lucide-react";
import { Link } from "react-router";
import { cn } from "../primitives/cn";
import { buttonStyles } from "../ui";
import { type Coverage, setupPath } from "./readiness";

/** A blocked form's pointer to Get Started: what is missing, and a way back here afterwards. */
export function SetupCallout({
  coverage,
  action,
  hint,
  from,
  className,
}: {
  coverage: Coverage;
  /** What the missing credentials block, as in "Connect a sandbox to {action}." */
  action: string;
  hint: string;
  from: string;
  className?: string;
}) {
  const missing =
    !coverage.model && !coverage.sandbox
      ? "a model and a sandbox"
      : !coverage.model
        ? "a model"
        : "a sandbox";
  return (
    <section
      aria-label="Setup Needed"
      className={cn(
        "flex flex-wrap items-center justify-between gap-4 border border-border bg-muted/60 p-4",
        className,
      )}
    >
      <div className="min-w-0 flex-1 basis-64">
        <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <span aria-hidden="true" className="size-2 shrink-0 bg-brand" />
          Connect {missing} to {action}.
        </p>
        <p className="mt-1 text-sm text-muted-foreground">{hint}</p>
      </div>
      <Link className={buttonStyles.primary} to={setupPath(from)}>
        Get Started
        <ArrowRight aria-hidden="true" />
      </Link>
    </section>
  );
}
