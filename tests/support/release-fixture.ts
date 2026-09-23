import { evaluationTaskKey, type Harness } from "../../src/evaluation/models.js";
import type { EvaluationRun, EvaluationTrial } from "../../src/evaluation/types.js";
import type { ReleaseInputs } from "../../src/public/release-build.js";
import type { CredentialFacts } from "../../src/public/release-results.js";
import type { ReleaseTask } from "../../src/public/release-rule.js";

/** Task keys t1, t2, ... as the rule identifies them: generation run plus task id. */
export const key = (name: string) => evaluationTaskKey("gen", name);
export const names = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => `t${from + index}`);

export function approvedTasks(list: readonly string[]): ReleaseTask[] {
  return list.map((name) => ({
    key: key(name),
    runId: "gen",
    taskId: name,
    state: "accepted",
    runnable: true,
    difficulty: "medium",
  }));
}

/** Credentials by id: an API key, a ChatGPT sign-in, and two custom endpoints. */
const credentials = new Map<string, CredentialFacts>([
  ["key", { auth: "api-key" }],
  ["chatgpt", { auth: "codex-login" }],
  ["host-a", { auth: "api-key", endpoint: "https://a.example/v1" }],
  ["host-b", { auth: "api-key", endpoint: "https://b.example/v1" }],
]);

interface RunSpec {
  model: string;
  harness?: Harness;
  thinking?: EvaluationRun["thinking"];
  credential?: string;
  provider?: "openai" | "anthropic" | "openrouter" | "custom";
  createdAt?: string;
  /** Task name to reward; a number is the reward, an object overrides trial fields. */
  results: Record<string, number | Partial<EvaluationTrial>>;
}

let sequence = 0;

/** One run of one setting with a trial per listed task, completed and verified by default. */
export function run(spec: RunSpec): EvaluationRun {
  sequence += 1;
  const harness = spec.harness ?? "codex";
  const provider = spec.provider ?? "openai";
  const createdAt = spec.createdAt ?? `2026-09-01T00:00:${String(sequence % 60).padStart(2, "0")}Z`;
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    repoId: 1,
    tenant: "acme",
    startedBy: "priya",
    createdAt,
    model: provider === "custom" ? "custom" : spec.model,
    modelName: provider === "custom" ? `openai/${spec.model}` : `openai/${spec.model}`,
    ...(spec.thinking ? { thinking: spec.thinking } : {}),
    harnesses: [harness],
    sandbox: "modal",
    credentials: {
      modelCredentialId: spec.credential ?? "key",
      sandboxCredentialId: "sandbox",
      provider,
    },
    revision: 1,
    modelLabel: spec.model.toUpperCase(),
    status: "completed",
    trials: Object.entries(spec.results).map(([name, value]) => ({
      taskId: name,
      runId: "gen",
      harness,
      status: "completed",
      rewards: { reward: typeof value === "number" ? value : 1 },
      log: "",
      steps: [],
      artifacts: [],
      modelVerified: true,
      apiCostUsd: 1,
      finishedAt: createdAt,
      ...(typeof value === "number" ? {} : value),
    })),
  };
}

/** Full coverage of `tasks` by `model`, passing every task. */
export const full = (model: string, tasks: readonly string[], extra: Partial<RunSpec> = {}) =>
  run({ model, results: Object.fromEntries(tasks.map((name) => [name, 1])), ...extra });

export function inputs(
  partial: Partial<ReleaseInputs> & Pick<ReleaseInputs, "runs">,
): ReleaseInputs {
  return {
    tasks: approvedTasks(names(1, 40)),
    credentials,
    everReleased: new Set(),
    ...partial,
  };
}
