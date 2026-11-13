import {
  conditionHarness,
  conditionRunsOn,
  type PickedCondition,
  SKILL_HARNESSES,
} from "../../../../src/contracts/conditions";
import type { CredentialInfo } from "../../../../src/db/credentials";
import type { CatalogModel } from "../../../../src/evaluation/catalog";
import { type Harness, harnessLabels } from "../../../../src/evaluation/models";
import { providerServesSubagent } from "../../../../src/evaluation/subagents";
import type { SavedCondition } from "../conditions/condition-api";
import type { EnvironmentItem } from "../environments/environment-api";
import { credentialRunsAll } from "./model-selection";
import type { RunDraft } from "./RunExecution";

/** What the Run page's conditions pick from, and what serves a picked condition's subagents. */
export interface ConditionChoices {
  /** The workspace's saved conditions; undefined until they load. */
  saved: SavedCondition[] | undefined;
  /** The repository's environments; none for a benchmark or a group. */
  environments: EnvironmentItem[];
  /** The repository whose environments these are, when the page is a repository's. */
  repo?: string;
  models: CatalogModel[];
  credentials: CredentialInfo[];
}

/** The harnesses the draft's models run, in the order they were picked. */
function pickedHarnesses(draft: Pick<RunDraft, "models">): Harness[] {
  return [...new Set(draft.models.flatMap((model) => model.harnesses))];
}

/**
 * The rows a condition with a subagent model runs on, as the harnesses of each that take one: a
 * row on the subagent model itself has nothing to delegate to, and is left out.
 */
function delegatingRows(condition: SavedCondition, draft: Pick<RunDraft, "models">): Harness[][] {
  return draft.models
    .filter((row) => row.catalogId !== condition.subagent?.catalogId)
    .map((row) => row.harnesses.filter((harness) => conditionRunsOn(condition, harness)))
    .filter((harnesses) => harnesses.length > 0);
}

/** The credentials that can serve a condition's subagent model beside every row it runs on. */
export function subagentCredentials(
  condition: SavedCondition,
  draft: Pick<RunDraft, "models">,
  { models, credentials }: Pick<ConditionChoices, "models" | "credentials">,
): CredentialInfo[] {
  const model = models.find((entry) => entry.id === condition.subagent?.catalogId);
  if (!model) return [];
  const rows = delegatingRows(condition, draft);
  return credentials.filter(
    (credential) =>
      providerServesSubagent(credential.kind) &&
      rows.every((harnesses) => credentialRunsAll(model, credential, harnesses)),
  );
}

/** The credential a picked condition's subagents run on: the one picked while it can, else the first that can. */
export function subagentCredential(
  picked: PickedCondition,
  condition: SavedCondition,
  draft: Pick<RunDraft, "models">,
  choices: Pick<ConditionChoices, "models" | "credentials">,
): CredentialInfo | undefined {
  const able = subagentCredentials(condition, draft, choices);
  return able.find((credential) => credential.id === picked.subagentCredentialId) ?? able[0];
}

/** Why the draft's conditions can't run, if they can't; undefined when they can. */
export function conditionsProblem(draft: RunDraft, choices: ConditionChoices): string | undefined {
  const picked = draft.conditions ?? [];
  if (draft.baseline === false && picked.length === 0)
    return "Run the baseline or add a condition.";
  const harnesses = pickedHarnesses(draft);
  const seen = new Set<string>();
  for (const entry of picked) {
    if (entry.saved === undefined && entry.environment === undefined)
      return "Pick a condition or an environment for each row, or remove the row.";
    const key = `${entry.saved ?? ""}:${entry.environment ?? ""}`;
    if (seen.has(key)) return "Pick each condition once.";
    seen.add(key);
    if (entry.saved === undefined || !choices.saved) continue;
    const condition = choices.saved.find((saved) => saved.id === entry.saved);
    if (!condition) return "A picked condition was deleted. Pick another.";
    const { name, subagent } = condition;
    // Nothing more to check until a model is picked; the models panel asks for one.
    if (harnesses.length === 0) continue;
    const runsOn = harnesses.filter((harness) => conditionRunsOn(condition, harness));
    const only = conditionHarness(condition);
    if (runsOn.length === 0)
      return subagent && !harnesses.some((harness) => conditionRunsOn({ subagent }, harness))
        ? `${name} sets a subagent model, which only Claude Code and Codex take.`
        : `${name} is for ${only ? harnessLabels[only] : "a harness"}, which no picked model runs.`;
    const unsupported = runsOn.find((harness) => !SKILL_HARNESSES.includes(harness));
    if (condition.skills.length && unsupported)
      return `${name} adds skills, which ${harnessLabels[unsupported]} can't load. Skills run on Claude Code, Codex, and Pi.`;
    if (!subagent) continue;
    if (delegatingRows(condition, draft).length === 0)
      return `${name} runs subagents on a model every picked row already runs. Add another model.`;
    if (!subagentCredential(entry, condition, draft, choices))
      return `${name} needs a credential that serves its subagent model.`;
  }
  return undefined;
}

/**
 * The draft's conditions as the server takes them: each saved condition with the credential its
 * subagents run on, when it has a subagent model.
 */
export function submittedConditions(
  draft: RunDraft,
  choices: ConditionChoices,
): Pick<RunDraft, "conditions" | "baseline"> {
  const conditions = (draft.conditions ?? []).map((entry): PickedCondition => {
    const condition = choices.saved?.find((saved) => saved.id === entry.saved);
    const credential = condition?.subagent
      ? subagentCredential(entry, condition, draft, choices)
      : undefined;
    return {
      ...(entry.saved !== undefined ? { saved: entry.saved } : {}),
      ...(entry.environment !== undefined ? { environment: entry.environment } : {}),
      ...(credential ? { subagentCredentialId: credential.id } : {}),
    };
  });
  return {
    ...(conditions.length ? { conditions } : {}),
    ...(draft.baseline === false ? { baseline: false } : {}),
  };
}
