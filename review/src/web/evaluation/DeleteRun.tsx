import React from "react";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "../Dialog";
import { Button, Notice } from "../ui";
import { type EvaluationRun, evaluationRequest } from "./api";

/**
 * Deletes a run after confirmation: it leaves Results, the chart and new releases, and is stopped
 * first if it is still running.
 */
export function DeleteRun({
  endpoint,
  live,
  onDeleted,
}: {
  /** The run's delete action. */
  endpoint: string;
  /** Whether the run is still queued or running, which deleting stops. */
  live: boolean;
  onDeleted(run: EvaluationRun): void;
}) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const submitting = React.useRef(false);
  const keep = React.useRef<HTMLButtonElement>(null);
  const titleId = React.useId();
  const close = () => setOpen(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Delete Run</Button>
      {open && (
        <Dialog
          initialFocus={keep}
          onDismiss={close}
          busy={busy}
          size="small"
          aria-labelledby={titleId}
        >
          <DialogHeader title="Delete Run?" titleId={titleId} onClose={close} busy={busy} />
          <DialogBody>
            <p className="text-sm text-muted-foreground">
              {live ? "Its running trials are stopped, and its" : "Its"} results leave this page,
              the chart and new releases. Releases already published keep showing them.
            </p>
            {error && <Notice>{error}</Notice>}
          </DialogBody>
          <DialogFooter>
            <Button ref={keep} disabled={busy} onClick={close}>
              Keep Run
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                if (submitting.current) return;
                submitting.current = true;
                setBusy(true);
                setError(undefined);
                try {
                  onDeleted(await evaluationRequest<EvaluationRun>(endpoint, {}));
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : "Could not delete the run.");
                  submitting.current = false;
                  setBusy(false);
                }
              }}
            >
              {busy ? "Deleting…" : "Delete Run"}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </>
  );
}
