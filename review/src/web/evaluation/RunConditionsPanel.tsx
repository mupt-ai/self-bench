import { ChevronDown, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import React from "react";
import { MAX_CONDITIONS, MAX_SKILL_LENGTH, MAX_SKILLS } from "../../../../src/contracts/conditions";
import { type EnvironmentItem, listEnvironments } from "../environments/environment-api";
import { cn } from "../primitives/cn";
import { InfoTooltip } from "../primitives/tooltip";
import { useOrg } from "../SiteLayout";
import { Button, controlStyles, fieldStyles, Input, Select } from "../ui";
import type { RunDraft } from "./RunExecution";
import { RunHarnessOptions } from "./RunHarnessOptions";
import { pickedHarnesses } from "./run-conditions";
import { useEvaluationScope } from "./useEvaluationScope";

type Condition = NonNullable<RunDraft["conditions"]>[number];

/**
 * Run conditions: what every task also runs under, beside the tasks as they are (the baseline).
 * A condition runs each task in a repository environment (its files changed and built), adds
 * skills, which Harbor installs for the agent, appends instructions to each task's instruction, or
 * sets options on each harness's agent; results keep it apart, so its pass rate compares with the
 * baseline's.
 */
export function RunConditionsPanel({
  draft,
  disabled,
  onChange,
}: {
  draft: RunDraft;
  disabled: boolean;
  onChange: (draft: RunDraft) => void;
}) {
  const conditions = draft.conditions ?? [];
  const baseline = draft.baseline !== false;
  const { org } = useOrg();
  const { repo } = useEvaluationScope();
  const [environments, setEnvironments] = React.useState<EnvironmentItem[]>([]);
  React.useEffect(() => {
    // Only a repository has environments; a benchmark's or group's conditions are run-time only.
    if (!repo) return;
    let stopped = false;
    listEnvironments(org.login, repo).then(
      (found) => {
        if (!stopped) setEnvironments(found);
      },
      () => undefined,
    );
    return () => {
      stopped = true;
    };
  }, [org.login, repo]);
  const set = (next: Condition[], keepBaseline = baseline) =>
    onChange({ ...draft, conditions: next, baseline: keepBaseline });
  const update = (index: number, patch: Partial<Condition>) =>
    set(conditions.map((condition, at) => (at === index ? { ...condition, ...patch } : condition)));
  const summary = [
    ...(baseline ? ["Baseline"] : []),
    ...conditions.map((condition) => condition.name.trim() || "Unnamed Condition"),
  ].join(" · ");
  return (
    <details className="group panel mb-5" open={conditions.length > 0 || undefined}>
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 marker:hidden [&::-webkit-details-marker]:hidden">
        <SlidersHorizontal className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-sm font-semibold">
            Conditions
            <InfoTooltip label="Run every task again with skills, extra instructions, or harness options. Results show each condition apart from the baseline, the tasks as they are." />
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
            onChange={(event) => set(conditions, event.target.checked)}
          />
          <span>
            <span className="font-semibold">Baseline</span>
            <span className="text-muted-foreground"> · The tasks as they are</span>
          </span>
        </label>
        {conditions.map((condition, index) => (
          <fieldset
            // Conditions have no id until submitted; their order is stable while editing.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above.
            key={index}
            aria-label={condition.name || `Condition ${index + 1}`}
            className="grid gap-4 border-t border-border pt-4"
            disabled={disabled}
          >
            <div className="flex items-end gap-3">
              <label htmlFor={`condition-${index}-name`} className={cn(fieldStyles, "flex-1")}>
                Condition Name
                <Input
                  id={`condition-${index}-name`}
                  aria-label="Condition Name"
                  maxLength={60}
                  placeholder="With Next.js Skills"
                  value={condition.name}
                  onChange={(event) => update(index, { name: event.target.value })}
                />
              </label>
              <Button
                variant="ghost"
                aria-label={`Remove ${condition.name || "Condition"}`}
                onClick={() => set(conditions.filter((_, at) => at !== index))}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </div>
            {environments.length > 0 && (
              <label htmlFor={`condition-${index}-environment`} className={fieldStyles}>
                <span className="flex items-center gap-1.5">
                  Environment
                  <InfoTooltip label="Run each task as an environment built it, with its files changed. Tasks it has no ready build for are left out of this condition." />
                </span>
                <Select
                  id={`condition-${index}-environment`}
                  aria-label="Environment"
                  value={condition.environment ?? ""}
                  onChange={(event) => {
                    const picked = environments.find(
                      (environment) => String(environment.id) === event.target.value,
                    );
                    update(index, {
                      environment: picked?.id,
                      // A condition that is only an environment is named after it.
                      ...(picked && !condition.name.trim() ? { name: picked.name } : {}),
                    });
                  }}
                >
                  <option value="">None: The Tasks as They Are</option>
                  {environments.map((environment) => (
                    <option key={environment.id} value={environment.id}>
                      {environment.name} ({environment.tasks.ready} of {environment.tasks.total}{" "}
                      Ready)
                    </option>
                  ))}
                </Select>
              </label>
            )}
            <div className={fieldStyles}>
              <span className="flex items-center gap-1.5">
                Skills
                <InfoTooltip label="A GitHub repository whose skills/ folder holds the skills, as org/repo, org/repo@ref, or a URL. Claude Code, Codex, and Pi load them." />
              </span>
              {condition.skills.map((skill, at) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own.
                  key={at}
                  className="flex gap-2"
                >
                  <Input
                    aria-label={`Skill ${at + 1}`}
                    className="font-mono"
                    maxLength={MAX_SKILL_LENGTH}
                    placeholder="vercel/next.js@canary"
                    value={skill}
                    onChange={(event) =>
                      update(index, {
                        skills: condition.skills.map((value, row) =>
                          row === at ? event.target.value : value,
                        ),
                      })
                    }
                  />
                  <Button
                    variant="ghost"
                    aria-label={`Remove Skill ${at + 1}`}
                    onClick={() =>
                      update(index, { skills: condition.skills.filter((_, row) => row !== at) })
                    }
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
              ))}
              {condition.skills.length < MAX_SKILLS && (
                <div>
                  <Button
                    size="small"
                    onClick={() => update(index, { skills: [...condition.skills, ""] })}
                  >
                    <Plus aria-hidden="true" />
                    Add Skill
                  </Button>
                </div>
              )}
            </div>
            <label className={fieldStyles}>
              <span className="flex items-center gap-1.5">
                Extra Instructions
                <InfoTooltip label="Appended to every task's instruction for this condition." />
              </span>
              <textarea
                aria-label="Extra Instructions"
                rows={3}
                maxLength={4000}
                className={cn(controlStyles, "h-auto resize-y py-2")}
                placeholder="Optional. For example: read node_modules/next/dist/docs before changing caching."
                value={condition.instructions ?? ""}
                onChange={(event) => update(index, { instructions: event.target.value })}
              />
            </label>
            <RunHarnessOptions
              condition={condition}
              harnesses={pickedHarnesses(draft)}
              idPrefix={`condition-${index}`}
              onChange={(harnessOptions) => update(index, { harnessOptions })}
            />
          </fieldset>
        ))}
        {conditions.length < MAX_CONDITIONS && (
          <div>
            <Button
              disabled={disabled}
              onClick={() => set([...conditions, { name: "", skills: [""], instructions: "" }])}
            >
              <Plus aria-hidden="true" />
              Add Condition
            </Button>
          </div>
        )}
      </div>
    </details>
  );
}
