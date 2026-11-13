import { ChevronDown, SlidersHorizontal } from "lucide-react";
import React from "react";
import { Link } from "react-router";
import { MAX_PICKED } from "../../../../src/contracts/conditions";
import type { CredentialInfo } from "../../../../src/db/credentials";
import type { CatalogModel } from "../../../../src/evaluation/catalog";
import { listEnvironments } from "../environments/environment-api";
import { listHarnesses } from "../harnesses/harness-api";
import { harnessSummary } from "../harnesses/harness-summary";
import { cn } from "../primitives/cn";
import { InfoTooltip } from "../primitives/tooltip";
import { buttonStyles } from "../ui";
import type { RunDraft } from "./RunExecution";
import type { HarnessChoices } from "./run-harnesses";

/**
 * What a Run page picks from: the workspace's saved harnesses, and the repository's repo ablations
 * when the page is a repository's (a benchmark or a group has none).
 */
export function useHarnessChoices(
  org: string,
  repo: string | undefined,
  models: CatalogModel[],
  credentials: CredentialInfo[],
): HarnessChoices {
  const [saved, setSaved] = React.useState<HarnessChoices["saved"]>();
  const [environments, setEnvironments] = React.useState<HarnessChoices["environments"]>(
    repo ? undefined : [],
  );
  React.useEffect(() => {
    let stopped = false;
    const keep =
      <Value,>(set: (value: Value) => void) =>
      (value: Value) => {
        if (!stopped) set(value);
      };
    // A list that fails to load leaves its picker empty; the server checks what is submitted.
    listHarnesses(org).then(keep(setSaved), () => keep(setSaved)([]));
    if (repo) listEnvironments(org, repo).then(keep(setEnvironments), () => undefined);
    else setEnvironments([]);
    return () => {
      stopped = true;
    };
  }, [org, repo]);
  return { saved, environments, ...(repo ? { repo } : {}), models, credentials };
}

interface PickEntry {
  id: number;
  name: string;
  detail?: string;
}

/** One checkbox list: the picked ids, each one at most once, and no more than MAX_PICKED. */
function PickList({
  label,
  tooltip,
  entries,
  picked,
  disabled,
  onChange,
}: {
  label: string;
  tooltip: string;
  entries: PickEntry[];
  picked: number[];
  disabled: boolean;
  onChange: (picked: number[]) => void;
}) {
  // A pick whose entry is gone (deleted since) still shows, so it can be unpicked.
  const gone = picked
    .filter((id) => !entries.some((entry) => entry.id === id))
    .map((id): PickEntry => ({ id, name: `Deleted (${id})` }));
  return (
    <fieldset aria-label={label} className="grid gap-2" disabled={disabled}>
      <legend className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
        {label}
        <InfoTooltip label={tooltip} />
      </legend>
      {[...entries, ...gone].map((entry) => {
        const checked = picked.includes(entry.id);
        return (
          <label key={entry.id} className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-brand"
              checked={checked}
              disabled={!checked && picked.length >= MAX_PICKED}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...picked, entry.id]
                    : picked.filter((id) => id !== entry.id),
                )
              }
            />
            <span className="min-w-0">
              <span className="font-semibold">{entry.name}</span>
              {entry.detail && <span className="text-muted-foreground"> · {entry.detail}</span>}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

/**
 * What every task also runs with, beside the tasks as they are (the baseline): the workspace's
 * saved harnesses, which change the agent, and the repository's repo ablations, which change the
 * tasks. Every harness runs in every repo ablation too. Results keep each pair apart, so its pass
 * rate compares with the baseline's.
 */
export function RunHarnessesPanel({
  draft,
  choices,
  disabled,
  onChange,
}: {
  draft: RunDraft;
  choices: HarnessChoices;
  disabled: boolean;
  onChange: (draft: RunDraft) => void;
}) {
  const harnesses = draft.harnesses ?? [];
  const ablations = draft.environments ?? [];
  const baseline = draft.baseline !== false;
  const saved = choices.saved ?? [];
  const environments = choices.environments ?? [];
  const set = (patch: Pick<RunDraft, "harnesses" | "environments" | "baseline">) => {
    const next = { ...draft, ...patch };
    if (!next.harnesses?.length) delete next.harnesses;
    if (!next.environments?.length) delete next.environments;
    onChange(next);
  };
  const names = (ids: number[], from: { id: number; name: string }[]) =>
    ids.map((id) => from.find((entry) => entry.id === id)?.name ?? "Deleted");
  const summary = [
    ...(baseline ? ["Baseline"] : []),
    ...names(harnesses, saved),
    ...names(ablations, environments),
  ].join(", ");
  return (
    <details
      className="group panel mb-5"
      open={harnesses.length > 0 || ablations.length > 0 || undefined}
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 marker:hidden [&::-webkit-details-marker]:hidden">
        <SlidersHorizontal className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-sm font-semibold">
            Harnesses and Repo Ablations
            <InfoTooltip label="Run every task again with each saved harness, which changes the agent, and in each repo ablation, which changes the tasks. Every harness also runs in every repo ablation. Results show each apart from the baseline, the tasks and agent as they are." />
          </span>
          <span className="mt-1 block truncate text-sm text-muted-foreground">
            {summary || "Nothing to run"}
          </span>
        </span>
        <ChevronDown
          className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="grid gap-5 border-t border-border px-4 py-4">
        <label className="flex items-center gap-3 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-brand"
            checked={baseline}
            disabled={disabled}
            onChange={(event) => set({ baseline: event.target.checked })}
          />
          <span>
            <span className="font-semibold">Baseline</span>
            <span className="text-muted-foreground"> · The tasks and agent as they are</span>
          </span>
        </label>
        <div className="grid gap-5 sm:grid-cols-2">
          <PickList
            label="Harnesses"
            tooltip={`Saved changes to an agent: skills, instructions, options, or a subagent model on its credential. Pick up to ${MAX_PICKED}. Save and edit them under Harnesses in the sidebar.`}
            entries={saved.map((entry) => ({
              id: entry.id,
              name: entry.name,
              detail: harnessSummary(entry, choices.models).join(" · "),
            }))}
            picked={harnesses}
            disabled={disabled}
            onChange={(next) => set({ harnesses: next })}
          />
          {choices.repo && (
            <PickList
              label="Repo Ablations"
              tooltip={`Run each task as a repo ablation built it, with its files changed. Tasks it has no ready build for are left out. Pick up to ${MAX_PICKED}; every picked harness runs in each.`}
              entries={environments.map((environment) => ({
                id: environment.id,
                name: environment.name,
                detail: `${environment.tasks.ready} of ${environment.tasks.total} Ready`,
              }))}
              picked={ablations}
              disabled={disabled}
              onChange={(next) => set({ environments: next })}
            />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Link
            className={cn(buttonStyles.ghost, "text-sm")}
            to="/settings/harnesses"
            aria-label="Manage Harnesses"
          >
            Manage Harnesses
          </Link>
          {choices.repo && (
            <Link
              className={cn(buttonStyles.ghost, "text-sm")}
              to={`/repos/${choices.repo}/environments`}
              aria-label="Manage Repo Ablations"
            >
              Manage Repo Ablations
            </Link>
          )}
          {choices.saved?.length === 0 && environments.length === 0 && (
            <span className="text-sm text-muted-foreground">
              No saved harnesses or repo ablations yet.
            </span>
          )}
        </div>
      </div>
    </details>
  );
}
