import React from "react";
import { useNavigate } from "react-router";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "../Dialog";
import { Button, Notice } from "../ui";
import { type EvaluationRun, evaluationRequestId, type Harness } from "./api";
import { submitComparison } from "./comparison-submission";
import { retrySelection } from "./run-retry";

/**
 * Runs a finished run's errored tasks again after confirmation, as a new comparison with the
 * run's model, reasoning, credentials and sandbox. The setting's score takes the new results.
 */
export function RetryErroredTasks({
  run,
  harness,
  url,
  pages,
}: {
  run: EvaluationRun;
  harness: Harness;
  /** The scope's evaluations API. */
  url: string;
  /** Where the scope's pages live, for the comparison this starts. */
  pages: string;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  // One ID per confirmation, so resubmitting after an unconfirmed response never runs twice.
  const [id, setId] = React.useState(evaluationRequestId);
  const submitting = React.useRef(false);
  const keep = React.useRef<HTMLButtonElement>(null);
  const titleId = React.useId();
  const retry = retrySelection(run, harness, id);
  if (!retry) return null;
  const tasks = `${retry.errored} Errored ${retry.errored === 1 ? "Task" : "Tasks"}`;
  const close = () => setOpen(false);
  return (
    <>
      <Button
        onClick={() => {
          setId(evaluationRequestId());
          setError(undefined);
          setOpen(true);
        }}
      >
        Retry {tasks}
      </Button>
      {open && (
        <Dialog
          initialFocus={keep}
          onDismiss={close}
          busy={busy}
          size="small"
          aria-labelledby={titleId}
        >
          <DialogHeader title={`Retry ${tasks}?`} titleId={titleId} onClose={close} busy={busy} />
          <DialogBody>
            <p className="text-sm text-muted-foreground">
              A new run tries {retry.errored === 1 ? "it" : "them"} again with this run's model,
              credentials and sandbox, and may spend on the model. Tasks that have completed for
              this setting since are skipped. Its results replace the errors in this setting's
              score.
            </p>
            {error && <Notice>{error}</Notice>}
          </DialogBody>
          <DialogFooter>
            <Button ref={keep} disabled={busy} onClick={close}>
              Keep Errors
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={async () => {
                if (submitting.current) return;
                submitting.current = true;
                setBusy(true);
                setError(undefined);
                try {
                  const result = await submitComparison(url, retry.selection);
                  void navigate(`${pages}/comparisons/${result.id}`);
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : "Could not retry the tasks.");
                } finally {
                  submitting.current = false;
                  setBusy(false);
                }
              }}
            >
              {busy ? "Starting…" : `Retry ${tasks}`}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </>
  );
}
