import type { CredentialInfo } from "../../../../src/db/credentials";
import type { CatalogModel } from "../../../../src/evaluation/catalog";
import {
  credentialRunsHarness,
  type Harness,
  harnessOptions,
  modelHarnesses,
  routeFor,
} from "../../../../src/evaluation/models";
import type { SavedHarness } from "../harnesses/harness-api";
import { harnessSummary } from "../harnesses/harness-summary";
import { savedHarnessAgent } from "./run-harnesses";

/** One choice in a model row's Harness picker: an agent as it is, or a saved harness on one. */
export interface RowHarnessOption {
  /** The agent's id, or `saved:<id>` for a saved harness. */
  id: string;
  label: string;
  group?: string;
  detail?: string;
  agent: Harness;
  /** The saved harness's id, for one. */
  saved?: number;
}

export const savedHarnessOption = (id: number) => `saved:${id}`;

/**
 * What a model row's Harness picker offers: the agents its model and credential run (every agent
 * some credential runs the model on, until one is chosen), then the saved harnesses it can run,
 * each on its own agent, or on the row's when it names none.
 */
export function rowHarnessOptions(
  model: CatalogModel,
  credential: Pick<CredentialInfo, "kind" | "auth"> | undefined,
  /** The agent the row runs now, when it runs one. */
  current: Harness | undefined,
  saved: readonly SavedHarness[] | undefined,
  models: readonly CatalogModel[] = [],
): RowHarnessOption[] {
  const route = credential ? routeFor(model, credential.kind) : undefined;
  const supports = (harness: Harness) =>
    (route?.harnesses ?? modelHarnesses(model)).includes(harness) &&
    credentialRunsHarness(credential?.auth ?? "api-key", harness);
  const harnesses = (saved ?? []).flatMap((entry): RowHarnessOption[] => {
    const agent = savedHarnessAgent(entry, current);
    if (!agent || !supports(agent)) return [];
    return [
      {
        id: savedHarnessOption(entry.id),
        label: entry.name,
        group: "Saved Harnesses",
        detail: harnessSummary({ ...entry, agent }, models).join(" · "),
        agent,
        saved: entry.id,
      },
    ];
  });
  const agents = harnessOptions
    .filter((harness) => supports(harness.id))
    .map(
      (harness): RowHarnessOption => ({
        id: harness.id,
        label: harness.label,
        agent: harness.id,
        // Headed only when saved harnesses follow.
        ...(harnesses.length ? { group: "Agents" } : {}),
      }),
    );
  return [...agents, ...harnesses];
}
