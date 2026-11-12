import type { SavedCondition } from "./condition-api";

/** What a saved condition changes, as short parts: "2 skills", "subagents on Claude Haiku 5.5". */
export function conditionSummary(
  condition: Pick<SavedCondition, "skills" | "instructions" | "harnessOptions" | "subagent">,
  models: readonly { id: string; label: string }[] = [],
): string[] {
  const options = Object.values(condition.harnessOptions ?? {}).flatMap((set) =>
    Object.keys(set ?? {}),
  ).length;
  const { subagent } = condition;
  const count = (many: number, one: string) => `${many} ${one}${many === 1 ? "" : "s"}`;
  return [
    ...(condition.skills.length ? [count(condition.skills.length, "skill")] : []),
    ...(condition.instructions ? ["extra instructions"] : []),
    ...(options ? [count(options, "harness option")] : []),
    ...(subagent
      ? [
          `subagents on ${models.find((model) => model.id === subagent.catalogId)?.label ?? subagent.catalogId}`,
        ]
      : []),
  ];
}
