import type { EvaluationRun } from "./api";

export const tasks = ["t1", "t2", "t3"].map((taskId) => ({ runId: "gen", taskId }));
export const credentials = [
  { id: "key", kind: "openai" as const },
  { id: "sandbox", kind: "modal" as const },
];
let ids = 0;
export const newId = () => `id-${++ids}`;

export function run(
  model: string,
  harness: "codex" | "pi",
  trials: Record<string, EvaluationRun["trials"][number]["status"]>,
  more: Partial<EvaluationRun> = {},
): EvaluationRun {
  return {
    id: `${model}-${harness}-${Object.keys(trials).join("")}`,
    repoId: 1,
    tenant: "acme",
    startedBy: "priya",
    createdAt: "2026-11-01T00:00:00Z",
    model,
    modelName: `openai/${model}`,
    thinking: "high",
    harnesses: [harness],
    sandbox: "modal",
    credentials: { modelCredentialId: "key", sandboxCredentialId: "sandbox", provider: "openai" },
    revision: 1,
    modelLabel: model.toUpperCase(),
    status: "completed",
    trials: Object.entries(trials).map(([taskId, status]) => ({
      runId: "gen",
      taskId,
      harness,
      status,
      rewards: { reward: 1 },
      log: "",
      steps: [],
      artifacts: [],
    })),
    ...more,
  } as EvaluationRun;
}
