import React from "react";
import { useNavigate } from "react-router";
import type { CredentialInfo } from "../../../../src/db/credentials";
import type { CatalogModel } from "../../../../src/evaluation/catalog";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "../Dialog";
import { InfoTooltip } from "../primitives/tooltip";
import { Button, fieldStyles, Notice, Select } from "../ui";
import { type EvaluationRun, evaluationRequest, evaluationRequestId, type Harness } from "./api";
import { submitComparison } from "./comparison-submission";
import { credentialProvider } from "./credential-presentation";
import { retryModelCredentials, retrySandboxes, retrySelection } from "./run-retry";

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
  onStarted,
}: {
  run: EvaluationRun;
  /** The org's saved credentials, to choose the sandbox from. */
  credentials: readonly CredentialInfo[];
  harness: Harness;
  /** The scope's evaluations API. */
  url: string;
  /** Where the scope's pages live, for the comparison this starts. */
  pages: string;
  onStarted?(comparisonId: string): void;
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
  const [modelChoice, setModelChoice] = React.useState<string>();
  // The model catalog, which says which saved credentials can run this model on this harness.
  const [catalog, setCatalog] = React.useState<CatalogModel[]>();
  React.useEffect(() => {
    if (!open || catalog) return;
    let disposed = false;
    evaluationRequest<{ models: CatalogModel[] }>(`${url}/catalog`).then(
      (result) => {
        if (!disposed) setCatalog(result.models);
      },
      () => undefined,
    );
    return () => {
      disposed = true;
    };
  }, [open, catalog, url]);
  const ownModel = run.credentials?.modelCredentialId;
  const modelCredentials = retryModelCredentials(run, harness, credentials, catalog);
  const chosenModel = modelChoice ?? ownModel ?? "";
  // The run's own sandbox while it still exists; otherwise one has to be chosen.
  const chosen =
    sandbox ??
    sandboxes.find((choice) => choice.id === run.credentials?.sandboxCredentialId)?.id ??
    "";
  const retry = retrySelection(
    run,
    harness,
    id,
    chosen || undefined,
    credentials,
    chosenModel && chosenModel !== ownModel ? chosenModel : undefined,
  );
  if (!retry) return null;
  const tasks = `${retry.errored} Errored ${retry.errored === 1 ? "Task" : "Tasks"}`;
  const close = () => setOpen(false);
  return (
    <>
      <Button
        onClick={() => {
          setId(evaluationRequestId());
          setSandbox(undefined);
          setModelChoice(undefined);
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
            {modelCredentials.length > 1 && (
              <label className={fieldStyles} htmlFor={`${titleId}-model`}>
                <span className="flex items-center gap-1.5">
                  Model Credential
                  <InfoTooltip label="Results count toward the setting of the credential they ran on. A Dari router is a setting of its own." />
                </span>
                <Select
                  id={`${titleId}-model`}
                  value={chosenModel}
                  disabled={busy}
                  onChange={(event) => setModelChoice(event.target.value)}
                >
                  {modelCredentials.map((credential) => (
                    <option key={credential.id} value={credential.id}>
                      {`${credential.name} · ${credentialProvider(credential)}`}
                    </option>
                  ))}
                </Select>
              </label>
            )}
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
                  if (result.submissionError) {
                    setError(
                      result.submissionError ??
                        "Some runs were not submitted. Resume to finish them.",
                    );
                    return;
                  }
                  setOpen(false);
                  onStarted?.(result.id);
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
