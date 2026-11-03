import { SkipForward } from "lucide-react";
import React from "react";
import { useNavigate } from "react-router";
import { plural } from "../api";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "../Dialog";
import { Button, fieldStyles, Notice, Select } from "../ui";
import { type EvaluationOptions, evaluationRequestId } from "./api";
import { submitComparison } from "./comparison-submission";
import { useRepoRuns } from "./RepoRuns";
import { missingWork } from "./run-missing";
import { retrySandboxes } from "./run-retry";

/**
 * The top of the Run page: how many results the settings already run here are missing, and one
 * button that runs exactly those, each setting as it ran before. Nothing to pick: new tasks, and
 * tasks a setting errored on, are filled in for every setting at once.
 */
export function RunMissing({
  url,
  pages,
  tasks,
}: {
  /** The scope's evaluations API. */
  url: string;
  pages: string;
  /** The tasks the scope's runs can use now. */
  tasks: EvaluationOptions["tasks"];
}) {
  const { runs, credentials, loading, refresh } = useRepoRuns();
  const navigate = useNavigate();
  const [open, setOpen] = React.useState(false);
  const [sandbox, setSandbox] = React.useState<string>();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  // Ids fixed for one confirmation, so resubmitting after an unconfirmed response never runs twice.
  const ids = React.useRef<string[]>([]);
  const titleId = React.useId();
  const cancel = React.useRef<HTMLButtonElement>(null);
  const newest = [...runs]
    .filter((run) => !run.deletedAt && run.credentials)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  const sandboxes = newest ? retrySandboxes(newest, credentials) : [];
  const chosen =
    sandbox ??
    sandboxes.find((choice) => choice.id === newest?.credentials?.sandboxCredentialId)?.id ??
    "";
  let next = 0;
  const work =
    loading || tasks.length === 0
      ? undefined
      : missingWork(
          runs,
          tasks,
          credentials,
          () => {
            ids.current[next] ??= evaluationRequestId();
            return ids.current[next++] as string;
          },
          chosen || undefined,
        );
  if (loading || !newest) return null;
  if (!work)
    return (
      <p className="mb-5 text-sm text-muted-foreground">
        Every setting run here has a result on every task.
      </p>
    );
  const label = `Run ${plural(work.trials, "Missing Trial")}`;
  const close = () => setOpen(false);
  return (
    <section className="panel mb-5 flex flex-wrap items-center justify-between gap-3 p-4">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold">Missing Results</h2>
        <p className="text-sm text-muted-foreground">
          {plural(work.settings.length, "setting")} run here{" "}
          {work.settings.length === 1 ? "is" : "are"} missing {plural(work.trials, "result")}: new
          tasks, and tasks that errored.
        </p>
      </div>
      <Button
        variant="primary"
        onClick={() => {
          ids.current = [];
          setSandbox(undefined);
          setError(undefined);
          setOpen(true);
        }}
      >
        <SkipForward className="size-4" aria-hidden="true" />
        {label}
      </Button>
      {open && (
        <Dialog
          initialFocus={cancel}
          onDismiss={close}
          busy={busy}
          size="medium"
          aria-labelledby={titleId}
        >
          <DialogHeader
            title={`${label}?`}
            titleId={titleId}
            onClose={close}
            busy={busy}
            description="Each setting runs as it ran before: the same model, reasoning, and model credential."
          />
          <DialogBody>
            <ul className="panel max-h-64 divide-y divide-border overflow-auto text-sm">
              {work.settings.map((setting) => (
                <li key={setting.label} className="flex items-baseline gap-3 px-4 py-2">
                  <span className="min-w-0 flex-1 break-words">{setting.label}</span>
                  <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
                    {plural(setting.missing, "task")}
                  </span>
                </li>
              ))}
            </ul>
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
            {error && <Notice>{error}</Notice>}
          </DialogBody>
          <DialogFooter>
            <Button ref={cancel} disabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={busy || !chosen}
              onClick={async () => {
                setBusy(true);
                setError(undefined);
                try {
                  for (const selection of work.selections) {
                    const result = await submitComparison(url, selection);
                    if (result.submissionError) throw new Error(result.submissionError);
                    refresh(result.id);
                  }
                  setOpen(false);
                  void navigate(`${pages}/results`);
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : "Could not start the runs.");
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Starting…" : label}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </section>
  );
}
