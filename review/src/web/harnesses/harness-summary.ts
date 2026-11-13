import { conditionHarness } from "../../../../src/contracts/conditions";
import { harnessLabels } from "../../../../src/evaluation/models";
import type { SavedHarness } from "./harness-api";

/**
 * What a saved harness changes, as short parts: its agent, then "2 skills", "subagents on Claude
 * Haiku 5.5".
 */
export function harnessSummary(
  harness: Pick<SavedHarness, "agent" | "skills" | "instructions" | "harnessOptions" | "subagent">,
  models: readonly { id: string; label: string }[] = [],
): string[] {
  const options = Object.values(harness.harnessOptions ?? {}).flatMap((set) =>
    Object.keys(set ?? {}),
  ).length;
  const { subagent } = harness;
  const count = (many: number, one: string) => `${many} ${one}${many === 1 ? "" : "s"}`;
  const agent = conditionHarness({
    harness: harness.agent,
    harnessOptions: harness.harnessOptions,
  });
  return [
    ...(agent ? [harnessLabels[agent]] : []),
    ...(harness.skills.length ? [count(harness.skills.length, "skill")] : []),
    ...(harness.instructions ? ["extra instructions"] : []),
    ...(options ? [count(options, "option")] : []),
    ...(subagent
      ? [
          `subagents on ${models.find((model) => model.id === subagent.catalogId)?.label ?? subagent.catalogId}`,
        ]
      : []),
  ];
}
