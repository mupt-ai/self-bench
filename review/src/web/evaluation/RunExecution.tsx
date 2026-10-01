import { CircleAlert, KeyRound, Play, SkipForward } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import type { CredentialInfo } from "../../../../src/db/credentials";
import type { HostedSandbox } from "../../../../src/evaluation/catalog";
import type { ComparisonDraft } from "../../../../src/evaluation/comparisons";
import { cn } from "../primitives/cn";
import { InfoTooltip } from "../primitives/tooltip";
import type { Coverage } from "../setup/readiness";
import { SetupCallout } from "../setup/SetupCallout";
import { Button, buttonStyles, fieldStyles, Notice, Select } from "../ui";

/** Why the comparison can't run yet, for the notice above the task picker. Nothing while
 * the accepted tasks are still loading or once the request is submitted. */
export function runBlocker({
  draft,
  ready,
  submitted,
  tasksReady,
  pairs,
}: {
  draft: ComparisonDraft;
  ready: boolean;
  submitted: boolean;
  tasksReady: boolean;
  pairs: number;
}): string | undefined {
  if (ready || submitted || !tasksReady) return undefined;
  if (!draft.tasks.length) return "Select at least one accepted task to continue.";
  if (!pairs) return "Add a model to continue.";
  if (!draft.sandboxCredentialId) return "Select a sandbox credential to continue.";
  return "Check the credentials and harness for each model.";
}

export function RunBlockerNotice({ children }: { children: ReactNode }) {
  return (
    <Notice tone="info" className="mb-5 justify-start gap-2.5 py-2.5">
      <CircleAlert className="size-4 shrink-0 text-warning" aria-hidden="true" />
      {children}
    </Notice>
  );
}

/** Run with no model or sandbox to run on: what is missing, and the setup popup. */
export function RunSetupCallout({ coverage }: { coverage: Coverage }) {
  return (
    <SetupCallout
      className="mb-5"
      coverage={coverage}
      action="run evaluations"
      hint="A ChatGPT or Claude sign-in, or any model API key, can run evaluations. Modal, E2B, or Daytona runs the tasks."
    />
  );
}

export function RunExecution({
  repo,
  draft,
  credentials,
  sandboxes,
  submitted,
  busy,
  ready,
  pairs,
  onChange,
  onSubmit,
  onRunMissing,
  readOnly = false,
}: {
  repo: string;
  draft: ComparisonDraft;
  credentials: CredentialInfo[];
  sandboxes: (HostedSandbox | "managed")[];
  submitted: boolean;
  busy: boolean;
  ready: boolean;
  pairs: number;
  onChange(value: ComparisonDraft): void;
  onSubmit(): void;
  onRunMissing(): void;
  readOnly?: boolean;
}) {
  return (
    <aside className="panel min-w-0 xl:sticky xl:top-6">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Execution</h2>
        {!readOnly && (
          <Link
            className={cn(buttonStyles.secondary, "h-8 px-2.5 text-xs [&>svg]:size-3.5")}
            to={`/settings/credentials?return=${encodeURIComponent(`/repos/${repo}/run`)}`}
          >
            <KeyRound aria-hidden="true" />
            Credentials
          </Link>
        )}
      </div>
      <fieldset
        className="grid min-w-0 gap-4 border-0 p-4 sm:grid-cols-2 xl:grid-cols-1"
        disabled={readOnly || busy || submitted}
      >
        <label className={fieldStyles} htmlFor="runpage-field-0">
          <span className="flex items-center gap-1.5">
            Sandbox
            <InfoTooltip
              label={
                sandboxes.includes("managed")
                  ? "Managed sandboxes run on SelfBench's platform account. Other sandboxes use your own credential. Model usage follows each model's credential."
                  : "Sandboxes run on a credential you store. Model usage follows each model's credential."
              }
            />
          </span>
          <Select
            id="runpage-field-0"
            aria-label="Sandbox"
            value={draft.sandbox}
            onChange={(event) =>
              onChange({
                ...draft,
                sandbox: event.target.value as HostedSandbox | "managed",
                sandboxCredentialId: event.target.value === "managed" ? "managed-sandbox" : "",
              })
            }
          >
            {sandboxes.map((sandbox) => (
              <option key={sandbox} value={sandbox}>
                {sandbox === "managed"
                  ? "Managed"
                  : sandbox === "e2b"
                    ? "E2B"
                    : sandbox === "modal"
                      ? "Modal"
                      : "Daytona"}
              </option>
            ))}
          </Select>
        </label>
        {draft.sandbox !== "managed" && (
          <label className={fieldStyles} htmlFor="runpage-field-1">
            Sandbox Credential
            <Select
              id="runpage-field-1"
              aria-label="Sandbox Credential"
              value={draft.sandboxCredentialId}
              onChange={(event) => onChange({ ...draft, sandboxCredentialId: event.target.value })}
            >
              <option value="" disabled>
                Select Credential
              </option>
              {credentials
                .filter((entry) => entry.kind === draft.sandbox)
                .map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
            </Select>
          </label>
        )}
      </fieldset>
      <div className="border-t border-border p-4">
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Tasks</dt>
            <dd className="font-mono tabular-nums">{draft.tasks.length}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Model / Harness Pairs</dt>
            <dd className="font-mono tabular-nums">{pairs}</dd>
          </div>
          <div className="mt-3 flex justify-between gap-3 border-t border-border pt-3">
            <dt className="text-muted-foreground">Total Trials</dt>
            <dd className="font-mono tabular-nums">{pairs * draft.tasks.length}</dd>
          </div>
        </dl>
      </div>
      <div className="grid gap-2 border-t border-border p-4">
        <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
          Run
          <InfoTooltip
            label={
              submitted
                ? "Retry Same Comparison resubmits this request with the same ID."
                : "Run Missing Tasks skips tasks that already have completed results for these model and harness pairs. Run Full Comparison runs every selected task."
            }
          />
        </h3>
        <Button
          type="button"
          className="w-full"
          disabled={readOnly || busy || submitted || !ready}
          onClick={onRunMissing}
        >
          <SkipForward className="size-4" aria-hidden="true" />
          Run Missing Tasks
        </Button>
        <Button
          type="button"
          variant="primary"
          className="w-full"
          disabled={readOnly || busy || (!submitted && !ready)}
          onClick={onSubmit}
        >
          <Play className="size-4" aria-hidden="true" />
          {busy
            ? "Saving Comparison…"
            : submitted
              ? "Retry Same Comparison"
              : "Run Full Comparison"}
        </Button>
      </div>
    </aside>
  );
}
