import React from "react";
import { Link } from "react-router";
import {
  type BatchRepoId,
  BatchRequestError,
  type CandidateCounts,
  startBatch,
  validCandidateCounts,
} from "./batch-api";
import { batchPath } from "./batches/presentation";
import { Dialog, DialogFooter, DialogHeader } from "./Dialog";
import { GenerationFields } from "./GenerationFields";
import { GenerationSteps } from "./GenerationSteps";
import { Button, fieldStyles, Input } from "./ui";
import { useGenerationSettings } from "./useGenerationSettings";

export interface GenerateBatchProps {
  repoId: BatchRepoId;
  disabled?: boolean;
  /** Open the submitted batch, including starts whose confirmation was interrupted. */
  onStarted?: (runId: string, warning?: string) => void;
}

/** Two-step creation only; submitted batches are tracked in the repository history. */
export function GenerateBatch({ repoId, onStarted, disabled }: GenerateBatchProps) {
  const [open, setOpen] = React.useState(false);
  const [step, setStep] = React.useState<1 | 2>(1);
  const [counts, setCounts] = React.useState<CandidateCounts>({ easy: 1, medium: 1, hard: 1 });
  const [error, setError] = React.useState<string>();
  const [busy, setBusy] = React.useState(false);
  const [unconfirmed, setUnconfirmed] = React.useState(false);
  const submitting = React.useRef(false);
  const closeButton = React.useRef<HTMLButtonElement>(null);
  const { org, fullName } = repoId;
  const {
    settings,
    setSettings,
    options,
    error: optionsError,
    valid,
    reload,
  } = useGenerationSettings(org, fullName, open);
  const submit = async () => {
    if (step !== 2 || submitting.current || unconfirmed || !valid || !validCandidateCounts(counts))
      return;
    submitting.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const result = await startBatch({ org, fullName }, counts, settings);
      setOpen(false);
      onStarted?.(result.runId);
    } catch (cause) {
      if (cause instanceof BatchRequestError && cause.runId) {
        setOpen(false);
        onStarted?.(cause.runId, cause.message);
      } else {
        const uncertain = !(cause instanceof BatchRequestError) || (cause.status ?? 0) >= 500;
        setUnconfirmed(uncertain);
        setError(
          uncertain
            ? "Batch start could not be confirmed. Check batch history before starting another."
            : cause.message,
        );
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  return (
    <>
      <Button
        type="button"
        disabled={disabled}
        onClick={() => {
          setStep(1);
          setError(undefined);
          setUnconfirmed(false);
          setOpen(true);
        }}
      >
        Generate Batch
      </Button>
      {open && (
        <Dialog
          aria-labelledby="generate-batch-title"
          size="large"
          initialFocus={closeButton}
          busy={busy}
          onDismiss={() => setOpen(false)}
        >
          <DialogHeader
            title="Generate Batch"
            titleId="generate-batch-title"
            description={fullName}
            onClose={() => setOpen(false)}
            closeRef={closeButton}
            busy={busy}
          />
          <GenerationSteps step={step} firstStep="Set Counts" />
          <form
            className="min-w-0"
            onSubmit={(event) => {
              event.preventDefault();
              if (step === 1) {
                if (validCandidateCounts(counts)) setStep(2);
              } else void submit();
            }}
          >
            <div className="px-4 pb-6 sm:px-6">
              {step === 1 ? (
                <fieldset className="m-0 min-w-0 border-0 p-0">
                  <legend className="mb-4 text-sm font-medium">Candidates</legend>
                  <div className="grid grid-cols-3 gap-3">
                    {(
                      [
                        { tier: "easy", label: "Easy" },
                        { tier: "medium", label: "Medium" },
                        { tier: "hard", label: "Hard" },
                      ] as const
                    ).map(({ tier, label }) => (
                      <label key={tier} htmlFor={`batch-${tier}`} className={fieldStyles}>
                        {label}
                        <Input
                          id={`batch-${tier}`}
                          aria-label={`${label} Candidates`}
                          type="number"
                          min="0"
                          max="10000"
                          step="1"
                          required
                          value={Number.isNaN(counts[tier]) ? "" : counts[tier]}
                          disabled={busy}
                          onChange={(event) =>
                            setCounts((current) => ({
                              ...current,
                              [tier]: event.target.valueAsNumber,
                            }))
                          }
                        />
                      </label>
                    ))}
                  </div>
                  <p className="mt-3 text-xs text-muted-foreground">1–10,000 candidates total.</p>
                </fieldset>
              ) : (
                <div>
                  {optionsError ? (
                    <div role="alert" className="space-y-3 text-sm text-destructive">
                      <p>{optionsError}</p>
                      <Button type="button" onClick={reload}>
                        Try Again
                      </Button>
                    </div>
                  ) : !options ? (
                    <p role="status" className="text-sm text-muted-foreground">
                      Loading generation settings…
                    </p>
                  ) : (
                    <GenerationFields
                      value={settings}
                      onChange={setSettings}
                      options={options}
                      disabled={busy}
                    />
                  )}
                </div>
              )}
            </div>
            <DialogFooter className="sticky bottom-0 justify-between bg-card">
              <span className="text-sm text-muted-foreground">
                {validCandidateCounts(counts)
                  ? `${counts.easy + counts.medium + counts.hard} Candidates`
                  : "Set Candidate Counts"}
              </span>
              <div className="ml-auto flex gap-3">
                {step === 2 && (
                  <Button type="button" variant="ghost" disabled={busy} onClick={() => setStep(1)}>
                    Back
                  </Button>
                )}
                <Button
                  type="submit"
                  variant="primary"
                  disabled={
                    busy || unconfirmed || !validCandidateCounts(counts) || (step === 2 && !valid)
                  }
                >
                  {busy ? "Starting…" : step === 1 ? "Continue" : "Generate"}
                </Button>
              </div>
            </DialogFooter>
          </form>
          {error && (
            <p className="border-t border-border p-4 text-sm text-destructive sm:px-6" role="alert">
              {error}
              {unconfirmed && (
                <Link to={batchPath(fullName)} className="mt-2 block text-foreground underline">
                  View Batches
                </Link>
              )}
            </p>
          )}
        </Dialog>
      )}
    </>
  );
}
