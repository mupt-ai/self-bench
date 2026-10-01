import { cn } from "../primitives/cn";
import { Button } from "../ui";
import type { Coverage } from "./readiness";
import { useSetupStatus } from "./SetupStatus";

/** A blocked form's pointer to the setup popup: what is missing, and a button to fix it. */
export function SetupCallout({
  coverage,
  action,
  hint,
  onOpen,
  className,
}: {
  coverage: Coverage;
  /** What the missing credentials block, as in "Connect a sandbox to {action}." */
  action: string;
  hint: string;
  /** Runs before the popup opens, as when the blocked form is itself a dialog to close. */
  onOpen?: () => void;
  className?: string;
}) {
  const setup = useSetupStatus();
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
      <Button
        variant="primary"
        onClick={() => {
          onOpen?.();
          setup.openDialog();
        }}
      >
        Finish Setup
      </Button>
    </section>
  );
}
