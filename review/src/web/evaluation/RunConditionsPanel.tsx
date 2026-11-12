import { ChevronDown, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import React from "react";
import { Link } from "react-router";
import { MAX_CONDITIONS, type PickedCondition } from "../../../../src/contracts/conditions";
import type { CredentialInfo } from "../../../../src/db/credentials";
import type { CatalogModel } from "../../../../src/evaluation/catalog";
import { listConditions } from "../conditions/condition-api";
import { conditionSummary } from "../conditions/condition-summary";
import { listEnvironments } from "../environments/environment-api";
import { cn } from "../primitives/cn";
import { InfoTooltip } from "../primitives/tooltip";
import { Button, buttonStyles, fieldStyles, Select } from "../ui";
import type { RunDraft } from "./RunExecution";
import { type ConditionChoices, subagentCredential, subagentCredentials } from "./run-conditions";

/**
 * What a Run page's conditions pick from: the workspace's saved conditions, and the repository's
 * environments when the page is a repository's (a benchmark or a group has none).
 */
export function useConditionChoices(
  org: string,
  repo: string | undefined,
  models: CatalogModel[],
  credentials: CredentialInfo[],
): ConditionChoices {
  const [saved, setSaved] = React.useState<ConditionChoices["saved"]>();
  const [environments, setEnvironments] = React.useState<ConditionChoices["environments"]>([]);
  React.useEffect(() => {
    let stopped = false;
    const keep =
      <Value,>(set: (value: Value) => void) =>
      (value: Value) => {
        if (!stopped) set(value);
      };
    // A list that fails to load leaves its picker empty; the server checks what is submitted.
    listConditions(org).then(keep(setSaved), () => keep(setSaved)([]));
    if (repo) listEnvironments(org, repo).then(keep(setEnvironments), () => undefined);
    return () => {
      stopped = true;
    };
  }, [org, repo]);
  return { saved, environments, ...(repo ? { repo } : {}), models, credentials };
}

/**
 * Run conditions: what every task also runs under, beside the tasks as they are (the baseline).
 * Each row pairs one of the workspace's saved conditions, which changes the harness, with one of
 * the repository's environments, which changes the tasks, or names either alone. Results keep
 * each row apart, so its pass rate compares with the baseline's.
 */
export function RunConditionsPanel({
  draft,
  choices,
  disabled,
  onChange,
}: {
  draft: RunDraft;
  choices: ConditionChoices;
  disabled: boolean;
  onChange: (draft: RunDraft) => void;
}) {
  const conditions = draft.conditions ?? [];
  const baseline = draft.baseline !== false;
  const saved = choices.saved ?? [];
  const { environments } = choices;
  const set = (next: PickedCondition[], keepBaseline = baseline) =>
    onChange({ ...draft, conditions: next, baseline: keepBaseline });
  const update = (index: number, next: PickedCondition) =>
    set(conditions.map((condition, at) => (at === index ? next : condition)));
  const named = (picked: PickedCondition) =>
    [
      saved.find((condition) => condition.id === picked.saved)?.name,
      environments.find((environment) => environment.id === picked.environment)?.name,
    ]
      .filter(Boolean)
      .join(" · ") || "Unpicked Condition";
  const summary = [...(baseline ? ["Baseline"] : []), ...conditions.map(named)].join(", ");
  // A new row starts on the first saved condition no row has picked, else the first environment.
  const next: PickedCondition | undefined = (() => {
    const unpicked = saved.find((entry) => !conditions.some((row) => row.saved === entry.id));
    if (unpicked) return { saved: unpicked.id };
    return environments[0] ? { environment: environments[0].id } : undefined;
  })();
  return (
    <details className="group panel mb-5" open={conditions.length > 0 || undefined}>
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 marker:hidden [&::-webkit-details-marker]:hidden">
        <SlidersHorizontal className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-sm font-semibold">
            Conditions
            <InfoTooltip label="Run every task again under a saved condition, which changes the harness, in an environment, which changes the tasks, or both. Results show each apart from the baseline, the tasks and harness as they are." />
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
      <div className="grid gap-4 border-t border-border px-4 py-4">
        <label className="flex items-center gap-3 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-brand"
            checked={baseline}
            disabled={disabled}
            onChange={(event) => set(conditions, event.target.checked)}
          />
          <span>
            <span className="font-semibold">Baseline</span>
            <span className="text-muted-foreground"> · The tasks and harness as they are</span>
          </span>
        </label>
        {conditions.map((picked, index) => {
          const condition = saved.find((entry) => entry.id === picked.saved);
          const able = condition?.subagent ? subagentCredentials(condition, draft, choices) : [];
          const serving = condition?.subagent
            ? subagentCredential(picked, condition, draft, choices)
            : undefined;
          return (
            <fieldset
              // Rows have no identity until submitted; their order is stable while editing.
              // biome-ignore lint/suspicious/noArrayIndexKey: see above.
              key={index}
              aria-label={named(picked)}
              className="grid gap-2 border-t border-border pt-4"
              disabled={disabled}
            >
              <div className="grid items-end gap-3 sm:grid-cols-[repeat(auto-fit,minmax(11rem,1fr))_auto]">
                <label htmlFor={`condition-${index}-saved`} className={fieldStyles}>
                  <span className="flex items-center gap-1.5">
                    Condition
                    <InfoTooltip label="A saved condition: skills, instructions, harness options, or a subagent model. Save and edit them under Conditions in the sidebar." />
                  </span>
                  <Select
                    id={`condition-${index}-saved`}
                    aria-label="Condition"
                    value={picked.saved ?? ""}
                    onChange={(event) => {
                      const { saved: _, subagentCredentialId: __, ...rest } = picked;
                      const id = Number(event.target.value);
                      update(index, id ? { ...rest, saved: id } : rest);
                    }}
                  >
                    <option value="">Harness as It Is</option>
                    {picked.saved !== undefined && choices.saved && !condition && (
                      <option value={picked.saved} disabled>
                        Deleted Condition
                      </option>
                    )}
                    {saved.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.name}
                      </option>
                    ))}
                  </Select>
                </label>
                {environments.length > 0 && (
                  <label htmlFor={`condition-${index}-environment`} className={fieldStyles}>
                    <span className="flex items-center gap-1.5">
                      Environment
                      <InfoTooltip label="Run each task as one of this repository's environments built it, with its files changed. Tasks it has no ready build for are left out of this row." />
                    </span>
                    <Select
                      id={`condition-${index}-environment`}
                      aria-label="Environment"
                      value={picked.environment ?? ""}
                      onChange={(event) => {
                        const { environment: _, ...rest } = picked;
                        const id = Number(event.target.value);
                        update(index, id ? { ...rest, environment: id } : rest);
                      }}
                    >
                      <option value="">Tasks as They Are</option>
                      {environments.map((environment) => (
                        <option key={environment.id} value={environment.id}>
                          {environment.name} ({environment.tasks.ready} of {environment.tasks.total}{" "}
                          Ready)
                        </option>
                      ))}
                    </Select>
                  </label>
                )}
                {condition?.subagent && (
                  <label htmlFor={`condition-${index}-credential`} className={fieldStyles}>
                    <span className="flex items-center gap-1.5">
                      Subagent Credential
                      <InfoTooltip label="The credential that serves this condition's subagent model, through SelfBench's gateway. Only credentials that serve it beside every picked model are listed." />
                    </span>
                    <Select
                      id={`condition-${index}-credential`}
                      aria-label="Subagent Credential"
                      value={serving?.id ?? ""}
                      onChange={(event) =>
                        update(index, { ...picked, subagentCredentialId: event.target.value })
                      }
                    >
                      {!serving && (
                        <option value="" disabled>
                          No Credential Serves It
                        </option>
                      )}
                      {able.map((credential) => (
                        <option key={credential.id} value={credential.id}>
                          {credential.name}
                        </option>
                      ))}
                    </Select>
                  </label>
                )}
                <Button
                  variant="ghost"
                  aria-label={`Remove ${named(picked)}`}
                  onClick={() => set(conditions.filter((_, at) => at !== index))}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </div>
              {condition && (
                <p className="text-sm text-muted-foreground">
                  {conditionSummary(condition, choices.models).join(" · ")}
                </p>
              )}
            </fieldset>
          );
        })}
        <div className="flex flex-wrap items-center gap-3">
          {conditions.length < MAX_CONDITIONS && (
            <Button disabled={disabled || !next} onClick={() => next && set([...conditions, next])}>
              <Plus aria-hidden="true" />
              Add Condition
            </Button>
          )}
          <Link
            className={cn(buttonStyles.ghost, "text-sm")}
            to="/settings/conditions"
            aria-label="Manage Conditions"
          >
            Manage Conditions
          </Link>
          {choices.repo && (
            <Link
              className={cn(buttonStyles.ghost, "text-sm")}
              to={`/repos/${choices.repo}/environments`}
              aria-label="Manage Environments"
            >
              Manage Environments
            </Link>
          )}
          {choices.saved?.length === 0 && environments.length === 0 && (
            <span className="text-sm text-muted-foreground">
              No saved conditions or environments yet.
            </span>
          )}
        </div>
      </div>
    </details>
  );
}
