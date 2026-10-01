import type { ModelPricing, ThinkingLevel } from "../contracts/models.js";
import type { TaskImages } from "../contracts/task.js";
import type { CredentialInfo } from "../db/credentials.js";
import type { Harness } from "./models.js";

export type { Harness } from "./models.js";

type EvaluationSandbox = "docker" | "modal" | "e2b" | "daytona";
interface EvaluationTask {
  runId: string;
  taskId: string;
  bundleKey: string;
  /** The Modal images the task was verified on; Modal trials start from them. */
  images?: TaskImages;
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
  /**
   * The repository's agent minutes when the evaluation started (trialTimeouts). Evaluations from
   * before repositories set it ran with the default.
   */
  agentMinutes?: number;
  pricing?: ModelPricing;
  credentialOwnerId?: number;
  credentialOrgId?: number;
  comparisonId?: string;
  credentials?: {
    modelCredentialId: string;
    sandboxCredentialId: string;
    provider: "openai" | "anthropic" | "openrouter" | "custom";
    auth?: CredentialInfo["auth"];
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
  /** The attempt holding a running trial; another attempt may take it over until the solver starts. */
  claim?: string;
  /** When Harbor started; from then on the trial may have spent, so it never runs again. */
  solverStartedAt?: string;
  finishedAt?: string;
  modelVerified?: boolean;
  apiCostUsd?: number;
  tokenUsage?: TokenUsage;
  cacheWritesInferred?: boolean;
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
