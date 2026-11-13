import {
  conditionHarness,
  conditionRunsOn,
  SKILL_HARNESSES,
} from "../../../../src/contracts/conditions";
import type { CredentialInfo } from "../../../../src/db/credentials";
import type { CatalogModel } from "../../../../src/evaluation/catalog";
import { type Harness, harnessLabels } from "../../../../src/evaluation/models";
import { subagentCredentials } from "../../../../src/evaluation/subagents";
import type { EnvironmentItem } from "../environments/environment-api";
import type { SavedHarness } from "../harnesses/harness-api";
import type { RunDraft } from "./RunExecution";

/** What the Run page picks from: saved harnesses and repo ablations, and what serves subagents. */
export interface HarnessChoices {
  /** The workspace's saved harnesses; undefined until they load. */
  saved: SavedHarness[] | undefined;
  /** The repository's repo ablations; none for a benchmark or a group, undefined until they load. */
  environments: EnvironmentItem[] | undefined;
  models: CatalogModel[];
  credentials: CredentialInfo[];
}

type Row = RunDraft["models"][number];

/** A saved harness as the run contracts read it: its agent is the harness it changes. */
const changes = (saved: SavedHarness) => ({
  harness: saved.agent,
  harnessOptions: saved.harnessOptions,
  subagent: saved.subagent,
});

/**
 * The agent a saved harness runs on in a row whose agent is `current`: its own, or the row's when it
 * names none and fits it. Undefined when it can't run on that agent at all.
 */
export function savedHarnessAgent(
  saved: SavedHarness,
  current: Harness | undefined,
): Harness | undefined {
  const agent = conditionHarness(changes(saved)) ?? current;
  if (!agent || !conditionRunsOn(changes(saved), agent)) return undefined;
  if (saved.skills.length && !SKILL_HARNESSES.includes(agent)) return undefined;
  return agent;
}

/**
 * The credential a saved harness's subagents run on beside a row: its own while it can serve them,
 * else, when it names none, the first that can. None when nothing can.
 */
export function subagentCredential(
  saved: SavedHarness,
  row: Row,
  { models, credentials }: Pick<HarnessChoices, "models" | "credentials">,
): CredentialInfo | undefined {
  const model = models.find((entry) => entry.id === saved.subagent?.catalogId);
  if (!model) return undefined;
  const able = subagentCredentials(model, row.harnesses, credentials);
  const named = saved.subagent?.credentialId;
  return named ? able.find((credential) => credential.id === named) : able[0];
}

/** Why a row's saved harness can't run on it, if it can't. */
function rowProblem(row: Row, choices: HarnessChoices): string | undefined {
  if (row.harness === undefined || !choices.saved || !row.catalogId) return undefined;
  const saved = choices.saved.find((entry) => entry.id === row.harness);
  if (!saved) return "A row's saved harness was deleted. Pick another harness for it.";
  const [agent] = row.harnesses;
  if (!agent) return undefined;
  const { name, subagent } = saved;
  if (subagent && !conditionRunsOn({ subagent }, agent))
    return `${name} sets a subagent model, which only Claude Code and Codex take.`;
  const own = conditionHarness(changes(saved));
  if (own && own !== agent)
    return `${name} is for ${harnessLabels[own]}, not ${harnessLabels[agent]}.`;
  if (saved.skills.length && !SKILL_HARNESSES.includes(agent))
    return `${name} adds skills, which ${harnessLabels[agent]} can't load. Skills run on Claude Code, Codex, and Pi.`;
  if (!subagent) return undefined;
  if (subagent.catalogId === row.catalogId)
    return `${name} runs subagents on this row's own model. Pick another harness or model.`;
  if (!subagentCredential(saved, row, choices))
    return subagent.credentialId
      ? `${name}'s subagent credential can't serve its model beside this row's. Change it under Harnesses.`
      : `${name} needs a credential that serves its subagent model.`;
  return undefined;
}

/** Why the draft's saved harnesses and repo ablations can't run, if they can't. */
export function harnessesProblem(draft: RunDraft, choices: HarnessChoices): string | undefined {
  for (const row of draft.models) {
    const problem = rowProblem(row, choices);
    if (problem) return problem;
  }
  const ablations = draft.environments ?? [];
  if (draft.baseline === false && ablations.length === 0)
    return "Pick a repo ablation, or include the original tasks.";
  const { environments } = choices;
  if (environments && ablations.some((id) => !environments.some((entry) => entry.id === id)))
    return "A picked repo ablation was deleted. Unpick it.";
  return undefined;
}
