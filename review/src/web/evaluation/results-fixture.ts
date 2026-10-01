import type { CredentialInfo } from "../../../../src/db/credentials";
import type { EvaluationRun, EvaluationTrial } from "./api";

/** Runs and credentials for the Results page's tests. */

export const NOW = Date.parse("2026-09-28T12:00:00.000Z");
export const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

export const credentials: CredentialInfo[] = [
  { id: "openai-key", name: "OpenAI", kind: "openai", auth: "api-key", createdAt: at(9999) },
  {
    id: "gpu-a",
    name: "A",
    kind: "custom",
    auth: "api-key",
    createdAt: at(9999),
    endpoint: "https://gpu.example.test/a/v1",
  },
  {
    id: "gpu-b",
    name: "B",
    kind: "custom",
    auth: "api-key",
    createdAt: at(9999),
    endpoint: "https://gpu.example.test/b/v1",
  },
];

export type TrialSpec = Partial<EvaluationTrial> & { taskId: string };
export const passed = (taskId: string, minutes = 10): TrialSpec => ({
  taskId,
  status: "completed",
  rewards: { reward: 1 },
  modelVerified: true,
  apiCostUsd: 0.5,
  startedAt: at(200),
  finishedAt: at(200 - minutes),
});
export const errored = (taskId: string, error: string): TrialSpec => ({
  taskId,
  status: "failed",
  error,
  startedAt: at(200),
  finishedAt: at(190),
});

export function run(
  id: string,
  options: Partial<EvaluationRun> & { credential?: string },
  trials: TrialSpec[],
): EvaluationRun {
  const { credential = "openai-key", ...rest } = options;
  const custom = credential.startsWith("gpu");
  return {
    id,
    repoId: 1,
    tenant: "example",
    startedBy: "priya",
    createdAt: at(300),
    model: custom ? "custom" : "gpt-6",
    modelName: custom ? "openai/llama-70b" : "openai/gpt-6",
    modelLabel: custom ? "llama-70b" : "GPT-6",
    thinking: "high",
    harnesses: ["codex"],
    sandbox: "modal",
    credentials: {
      modelCredentialId: credential,
      sandboxCredentialId: "modal",
      provider: custom ? "custom" : "openai",
    },
    revision: 1,
    status: "completed",
    trials: trials.map((trial) => ({
      runId: "batch-1",
      harness: "codex",
      status: "queued",
      rewards: {},
      log: "",
      steps: [],
      artifacts: [],
      ...trial,
    })),
    ...rest,
  };
}
