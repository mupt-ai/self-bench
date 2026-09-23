import type { ModelPricing, ThinkingLevel } from "../contracts/models.js";
import type { Harness } from "./models.js";

export type { Harness } from "./models.js";

type EvaluationSandbox = "docker" | "modal" | "e2b" | "daytona";
interface EvaluationTask {
  runId: string;
  taskId: string;
  bundleKey: string;
}
export interface EvaluationInput {
  id: string;
  repoId: number;
  tenant: string;
  startedBy: string;
  createdAt: string;
  model: string;
  modelName: string;
  thinking?: ThinkingLevel;
  harnesses: Harness[];
  sandbox: EvaluationSandbox;
  tasks: EvaluationTask[];
  pricing?: ModelPricing;
  credentialOwnerId?: number;
  credentialOrgId?: number;
  comparisonId?: string;
  credentials?: {
    modelCredentialId: string;
    sandboxCredentialId: string;
    provider: "openai" | "anthropic" | "openrouter" | "custom";
  };
}
export interface SolverStep {
  id: string;
  role: string;
  text: string;
  tools: { id: string; name: string; input: string; output: string }[];
}
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export interface EvaluationTrial {
  taskId: string;
  runId: string;
  harness: Harness;
  status: "queued" | "running" | "completed" | "failed";
  rewards: Record<string, number>;
  error?: string;
  log: string;
  steps: SolverStep[];
  artifacts: string[];
  startedAt?: string;
  finishedAt?: string;
  modelVerified?: boolean;
  apiCostUsd?: number;
  tokenUsage?: TokenUsage;
  costSource?: "harbor" | "reference-rates";
}
export interface EvaluationRun extends Omit<EvaluationInput, "tasks"> {
  revision: number;
  datasetKey?: string;
  modelLabel: string;
  status: "queued" | "running" | "completed" | "failed";
  trials: EvaluationTrial[];
  finishedAt?: string;
  error?: string;
}
