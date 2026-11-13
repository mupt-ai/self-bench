import {
  conditionHarness,
  conditionRunsOn,
  MAX_PAIRS,
  SKILL_HARNESSES,
} from "../../../../src/contracts/conditions";
import type { CredentialInfo } from "../../../../src/db/credentials";
import type { CatalogModel } from "../../../../src/evaluation/catalog";
import { type Harness, harnessLabels } from "../../../../src/evaluation/models";
import { providerServesSubagent } from "../../../../src/evaluation/subagents";
import type { EnvironmentItem } from "../environments/environment-api";
import type { SavedHarness } from "../harnesses/harness-api";
import { credentialRunsAll } from "./model-selection";
import type { RunDraft } from "./RunExecution";

/** What the Run page picks from: saved harnesses and repo ablations, and what serves subagents. */
export interface HarnessChoices {
  /** The workspace's saved harnesses; undefined until they load. */
  saved: SavedHarness[] | undefined;
  /** The repository's repo ablations; none for a benchmark or a group, undefined until they load. */
  environments: EnvironmentItem[] | undefined;
  /** The repository whose repo ablations these are, when the page is a repository's. */
  repo?: string;
  models: CatalogModel[];
  credentials: CredentialInfo[];
}

/** A saved harness as the run contracts read it: its agent is the harness it changes. */
const changes = (saved: SavedHarness) => ({
  harness: saved.agent,
  harnessOptions: saved.harnessOptions,
  subagent: saved.subagent,
});

/** The harnesses the draft's models run, in the order they were picked. */
function pickedHarnesses(draft: Pick<RunDraft, "models">): Harness[] {
  return [...new Set(draft.models.flatMap((model) => model.harnesses))];
}

/**
 * The rows a saved harness with a subagent model runs on, as the harnesses of each that take one:
 * a row on the subagent model itself has nothing to delegate to, and is left out.
 */
function delegatingRows(saved: SavedHarness, draft: Pick<RunDraft, "models">): Harness[][] {
  return draft.models
    .filter((row) => row.catalogId !== saved.subagent?.catalogId)
    .map((row) => row.harnesses.filter((harness) => conditionRunsOn(changes(saved), harness)))
    .filter((harnesses) => harnesses.length > 0);
}

/**
 * The credential a saved harness's subagents run on beside the picked models: its own while it can
 * serve them, else, when it names none, the first that can. None when nothing can.
 */
export function subagentCredential(
  saved: SavedHarness,
  draft: Pick<RunDraft, "models">,
  { models, credentials }: Pick<HarnessChoices, "models" | "credentials">,
): CredentialInfo | undefined {
  const model = models.find((entry) => entry.id === saved.subagent?.catalogId);
  if (!model) return undefined;
  const rows = delegatingRows(saved, draft);
  const able = credentials.filter(
    (credential) =>
      providerServesSubagent(credential.kind) &&
      rows.every((harnesses) => credentialRunsAll(model, credential, harnesses)),
  );
  const named = saved.subagent?.credentialId;
  return named ? able.find((credential) => credential.id === named) : able[0];
}

/** Why the draft's harnesses and repo ablations can't run, if they can't; undefined when they can. */
export function harnessesProblem(draft: RunDraft, choices: HarnessChoices): string | undefined {
  const picked = draft.harnesses ?? [];
  const ablations = draft.environments ?? [];
  if (draft.baseline === false && picked.length === 0 && ablations.length === 0)
    return "Run the tasks as they are, or pick a harness or a repo ablation.";
  const pairs = (picked.length + 1) * (ablations.length + 1) - 1;
  if (pairs > MAX_PAIRS)
    return `That is ${pairs} harness and repo ablation pairs. Pick at most ${MAX_PAIRS}.`;
  const harnesses = pickedHarnesses(draft);
  for (const id of picked) {
    if (!choices.saved) break;
    const saved = choices.saved.find((entry) => entry.id === id);
    if (!saved) return "A picked harness was deleted. Unpick it.";
    const { name, subagent } = saved;
    // Nothing more to check until a model is picked; the models panel asks for one.
    if (harnesses.length === 0) continue;
    const runsOn = harnesses.filter((harness) => conditionRunsOn(changes(saved), harness));
    const only = conditionHarness(changes(saved));
    if (runsOn.length === 0)
      return subagent && !harnesses.some((harness) => conditionRunsOn({ subagent }, harness))
        ? `${name} sets a subagent model, which only Claude Code and Codex take.`
        : `${name} is for ${only ? harnessLabels[only] : "an agent"}, which no picked model runs.`;
    const unsupported = runsOn.find((harness) => !SKILL_HARNESSES.includes(harness));
    if (saved.skills.length && unsupported)
      return `${name} adds skills, which ${harnessLabels[unsupported]} can't load. Skills run on Claude Code, Codex, and Pi.`;
    if (!subagent) continue;
    if (delegatingRows(saved, draft).length === 0)
      return `${name} runs subagents on a model every picked row already runs. Add another model.`;
    if (!subagentCredential(saved, draft, choices))
      return subagent.credentialId
        ? `${name}'s subagent credential can't serve its model beside the picked models. Change it under Harnesses.`
        : `${name} needs a credential that serves its subagent model.`;
  }
  const { environments } = choices;
  if (environments && ablations.some((id) => !environments.some((entry) => entry.id === id)))
    return "A picked repo ablation was deleted. Unpick it.";
  return undefined;
}
