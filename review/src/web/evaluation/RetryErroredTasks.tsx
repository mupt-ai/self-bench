import React from "react";
import { useNavigate } from "react-router";
import type { CredentialInfo } from "../../../../src/db/credentials";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "../Dialog";
import { Button, fieldStyles, Notice, Select } from "../ui";
import { type EvaluationRun, evaluationRequestId, type Harness } from "./api";
import { hasUnconfirmedRuns, submitComparison } from "./comparison-submission";
import { retrySandboxes, retrySelection } from "./run-retry";

/**
 * Runs a finished run's errored tasks again after confirmation, as a new comparison with the
 * run's model, reasoning and model credential, on the run's sandbox or another the org saved. The
 * setting's score takes the new results.
 */
export function RetryErroredTasks({
  run,
  harness,
  url,
  pages,
  credentials,
}: {
  run: EvaluationRun;
  /** The org's saved credentials, to choose the sandbox from. */
  credentials: readonly CredentialInfo[];
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
  const sandboxes = retrySandboxes(run, credentials);
  const [sandbox, setSandbox] = React.useState<string>();
  // The run's own sandbox while it still exists; otherwise one has to be chosen.
  const chosen =
    sandbox ??
    sandboxes.find((choice) => choice.id === run.credentials?.sandboxCredentialId)?.id ??
    "";
  const retry = retrySelection(run, harness, id, chosen || undefined, credentials);
  if (!retry) return null;
  const tasks = `${retry.errored} Errored ${retry.errored === 1 ? "Task" : "Tasks"}`;
  const close = () => setOpen(false);
  return (
    <>
      <Button
        onClick={() => {
          setId(evaluationRequestId());
          setSandbox(undefined);
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
            <label className={fieldStyles} htmlFor={`${titleId}-sandbox`}>
              Sandbox
              <Select
                id={`${titleId}-sandbox`}
                value={chosen}
                disabled={busy}
                onChange={(event) => setSandbox(event.target.value)}
              >
                <option value="" disabled>
                  {sandboxes.length ? "Select Sandbox" : "No Sandbox Credentials"}
                </option>
                {sandboxes.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.label}
                  </option>
                ))}
              </Select>
            </label>
            {!chosen && (
              <p className="mt-2 text-sm text-muted-foreground">
                This run's sandbox credential no longer exists. Choose another, or add one under
                Credentials.
              </p>
            )}
            {error && <Notice>{error}</Notice>}
          </DialogBody>
          <DialogFooter>
            <Button ref={keep} disabled={busy} onClick={close}>
              Keep Errors
            </Button>
            <Button
              variant="primary"
              disabled={busy || !chosen}
              onClick={async () => {
                if (submitting.current) return;
                submitting.current = true;
                setBusy(true);
                setError(undefined);
                try {
                  const result = await submitComparison(url, retry.selection);
                  if (hasUnconfirmedRuns(result)) {
                    setError(
                      result.submissionError ??
                        "Some runs were not submitted. Resume to finish them.",
                    );
                    return;
                  }
                  void navigate(`${pages}/results`);
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
