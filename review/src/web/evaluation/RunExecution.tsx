import { Play } from "lucide-react";
import { Link } from "react-router";
import type { CredentialInfo } from "../../../../src/evaluation/account";
import type { HostedSandbox } from "../../../../src/evaluation/catalog";
import type { ComparisonDraft } from "../../../../src/evaluation/comparisons";
import { Button, fieldStyles, Select } from "../ui";

export function RunExecution({
  repo,
  draft,
  credentials,
  sandboxes,
  submitted,
  busy,
  ready,
  tasksReady,
  pairs,
  onChange,
  onSubmit,
}: {
  repo: string;
  draft: ComparisonDraft;
  credentials: CredentialInfo[];
  sandboxes: HostedSandbox[];
  submitted: boolean;
  busy: boolean;
  ready: boolean;
  tasksReady: boolean;
  pairs: number;
  onChange(value: ComparisonDraft): void;
  onSubmit(): void;
}) {
  return (
    <aside className="min-w-0 border border-border bg-card xl:sticky xl:top-6">
      <div className="flex items-center justify-between border-b border-border px-4 py-4">
        <h2 className="text-sm font-medium">Execution</h2>
        <Link
          className="text-xs text-muted-foreground hover:text-foreground"
          to={`/settings/credentials?return=${encodeURIComponent(`/repos/${repo}/run`)}`}
        >
          Credentials
        </Link>
      </div>
      <fieldset
        className="grid min-w-0 gap-4 border-0 p-4 sm:grid-cols-2 xl:grid-cols-1"
        disabled={busy || submitted}
      >
        <label className={fieldStyles} htmlFor="runpage-field-0">
          Sandbox
          <Select
            id="runpage-field-0"
            aria-label="Sandbox"
            value={draft.sandbox}
            onChange={(event) =>
              onChange({
                ...draft,
                sandbox: event.target.value as HostedSandbox,
                sandboxCredentialId: "",
              })
            }
          >
            {sandboxes.map((sandbox) => (
              <option key={sandbox} value={sandbox}>
                {sandbox === "e2b" ? "E2B" : sandbox === "modal" ? "Modal" : "Daytona"}
              </option>
            ))}
          </Select>
        </label>
        <label className={fieldStyles} htmlFor="runpage-field-1">
          Sandbox Credential
          <Select
            id="runpage-field-1"
            aria-label="Sandbox Credential"
            value={draft.sandboxCredentialId}
            onChange={(event) => onChange({ ...draft, sandboxCredentialId: event.target.value })}
          >
            <option value="">Select Credential</option>
            {credentials
              .filter((entry) => entry.kind === draft.sandbox)
              .map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
          </Select>
        </label>
      </fieldset>
      <div className="border-t border-border p-4">
        <dl className="mb-4 space-y-2 text-xs tabular-nums">
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Tasks</dt>
            <dd>{draft.tasks.length}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Model / Harness Pairs</dt>
            <dd>{pairs}</dd>
          </div>
          <div className="flex justify-between gap-3 border-t border-border pt-3 text-sm">
            <dt>Total Trials</dt>
            <dd className="font-medium">{pairs * draft.tasks.length}</dd>
          </div>
        </dl>
        <Button
          type="button"
          variant="primary"
          className="w-full"
          disabled={busy || (!submitted && !ready)}
          onClick={onSubmit}
        >
          <Play aria-hidden="true" />
          {busy ? "Saving Comparison…" : submitted ? "Retry Same Comparison" : "Run Comparison"}
        </Button>
        {!ready && !submitted && (
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            {!tasksReady
              ? "Accepted tasks are required to run."
              : !pairs
                ? "Add a model to continue."
                : !draft.sandboxCredentialId
                  ? "Select a sandbox credential to continue."
                  : "Check the credentials and harness for each model."}
          </p>
        )}
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          Model and sandbox usage is billed by your providers.
        </p>
      </div>
    </aside>
  );
}
