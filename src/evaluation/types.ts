import type { ModelPricing, ThinkingLevel } from "../contracts/models.js";
import type { TaskImages } from "../contracts/task.js";
import type { CredentialInfo } from "../db/credentials.js";
import type { JudgeNeeds } from "../harnesses/harbor/host-variables.js";
import type { CatalogProvider } from "./catalog.js";
import type { Harness } from "./models.js";
import type { EvaluationScope } from "./scope.js";

export type { Harness } from "./models.js";

type EvaluationSandbox = "docker" | "modal" | "e2b" | "daytona";
interface EvaluationTask {
  runId: string;
  taskId: string;
  bundleKey: string;
  /** The Modal images the task was verified on; Modal trials start from them. */
  images?: TaskImages;
  /**
   * A task frozen from Harbor's registry (freezeRegistryTasks), as `org/name@sha256:…`; its
   * bundle holds the task exactly as published, which trials run unchanged, with its own limits.
   */
  registry?: string;
  /** For a registry task, the most minutes a trial of it takes by its own limits. */
  minutes?: number;
  /** For a registry task with an LLM judge, the judge variables its judge credential fills. */
  judge?: JudgeNeeds;
}
export interface EvaluationInput extends EvaluationScope {
  id: string;
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
   * The repository's agent minutes when the evaluation started (trialTimeouts); benchmarks run
   * with the default. Evaluations from before repositories set it ran with the default.
   */
  agentMinutes?: number;
  /**
   * For registry tasks, which run with their own limits: the longest of them, in minutes, which
   * bounds each `harbor run` instead of agentMinutes (trialTimeouts).
   */
  taskMinutes?: number;
  /**
   * At most this many of the evaluation's trials run at once: its share of the sandbox and model
   * credentials' limits (maxSandboxes) when it started. A trial holds one sandbox at a time.
   */
  maxTrials?: number;
  pricing?: ModelPricing;
  /**
   * Failed trials are explained (failure-summary.ts), which sends their material to the summary
   * model through SelfBench's account: set for a public repository, or one already running on
   * managed model access.
   */
  explainFailures?: boolean;
  credentialOwnerId?: number;
  credentialOrgId?: number;
  comparisonId?: string;
  credentials?: {
    modelCredentialId: string;
    sandboxCredentialId: string;
    provider: CatalogProvider;
    auth?: CredentialInfo["auth"];
    /** A benchmark's LLM judge: the credential its tasks' judge variables come from. */
    judgeCredentialId?: string;
  };
}
export interface SolverStep {
  id: string;
  role: string;
  text: string;
  tools: { id: string; name: string; input: string; output: string }[];
}
/** One trial to explain (failure-summary.ts): its evaluation, its place there, and its task. */
export interface FailedTrial {
  repoId: number;
  id: string;
  index: number;
  /** The task's bundle, to rebuild the trial's material from when it kept none. */
  bundleKey?: string;
  /** Explicit on-demand BYOK selection. Only references, never secrets, enter workflow history. */
  explanation?: { orgId: number; credentialId: string; model: string };
}
/** A model's explanation of a failed trial, and the catalog id of the model that wrote it. */
export interface FailureSummary {
  text: string;
  model: string;
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
  /**
   * The agent was stopped at its time limit (agentMinutes). Harbor grades what it left, as for
   * any other agent, so the trial completes with that score.
   */
  agentTimedOut?: boolean;
  /**
   * The task's tests ran past their time limit, so the trial failed (reward 0) rather than
   * erroring, as Harbor scores it: a solution that hangs its tests is the agent's.
   */
  verifierTimedOut?: boolean;
  /** Why a completed trial failed its tests, in plain language (failure-summary.ts). */
  failureSummary?: FailureSummary;
  modelVerified?: boolean;
  apiCostUsd?: number;
  /** The amount is known spend, not a complete total; some requests lack prices. */
  costIncomplete?: true;
  tokenUsage?: TokenUsage;
  cacheWritesInferred?: boolean;
  /**
   * "gateway": a gateway's charge, where list rates cannot price the trial (billedTrialCost), and
   * on trials recorded before costs moved to vendor list rates.
   */
  /** Router reference rates sum the selected providers' per-request costs, not cash charges. */
  costSource?: "harbor" | "reference-rates" | "gateway" | "router-reference-rates";
  /** What the gateway charged, for comparing with the bill; apiCostUsd is the cost shown. */
  billedCostUsd?: number;
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
