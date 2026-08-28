import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CancelledFailure, Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { z } from "zod";
import { type ArtifactStore, createArtifactStore } from "../artifacts.js";
import { auditTaskDefinition } from "../audit.js";
import {
  COUPLING_REVIEW_MODEL,
  couplingReviewInput,
  couplingReviewSchema,
} from "../codex-review.js";
import type { SelfBenchConfig, SelfBenchWorkerConfig } from "../config.js";
import {
  type ArtifactRef,
  type AuditResult,
  type AuthoredTask,
  type AuthoredTaskDraft,
  type AuthorOutcome,
  type Candidate,
  candidateSchema,
  type Difficulty,
  type DiscoveryResult,
  type EnvironmentPreflightResult,
  type ReviewResult,
  type RunRequest,
  type TaskAuthorOutcome,
  taskDefinitionSchema,
  taskDraftDefinitionSchema,
  type ValidationResult,
} from "../contracts.js";
import {
  buildCouplingEvidence,
  discoverContractArtifacts,
  resolveCouplingReview,
  scanBaseContractArtifacts,
} from "../coupling.js";
import {
  assertEnvironmentOnlyRepair,
  assertEnvironmentPolicy,
  environmentAuthoringPrompt,
} from "../environment.js";
import { assertPullRequestBelongsToRepository } from "../github.js";
import { harborChildEnvironment } from "../harbor-environment.js";
import {
  type HarborJobResult,
  harborInfrastructureError,
  readHarborJobResult,
} from "../harbor-results.js";
import { refreshHarborTask } from "../harbor-task.js";
import { sha256 } from "../hash.js";
import { runCommand } from "../process.js";
import { projectRoot } from "../project-paths.js";
import {
  assertProvenanceMatchesPullRequest,
  collectGitHubPullRequestProvenance,
  combineRunProvenance,
  type ProvenanceMessage,
  provenanceMessageSchema,
} from "../provenance.js";
import {
  createSandboxExecutor,
  SandboxExecutionError,
  type SandboxExecutor,
  type SandboxResult,
  type SandboxRunOptions,
} from "../sandbox/index.js";
import { githubToken, loadCodexModelAuth, loadPiModelAuth } from "../subscription-auth.js";

const HARBOR_INFRASTRUCTURE_FAILURE_TYPE = "HarborInfrastructureFailure";
const DISCOVERY_TIMEOUT_MS = 45 * 60 * 1000;
const AGENT_INACTIVITY_TIMEOUT_MS = 8 * 60 * 1000;
const AUTHORING_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const REVIEW_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;

const discoveryPlanSchema = z.object({
  candidates: z.array(
    z.object({
      candidateId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
      difficulty: z.enum(["easy", "medium", "hard"]),
      sourcePr: z.number().int().positive(),
      sourceUrl: z.string().url(),
      baseCommit: z.string().regex(/^[0-9a-f]{40}$/i),
      completedCommit: z.string().regex(/^[0-9a-f]{40}$/i),
      provenance: z.object({
        sourceType: z.enum(["pi", "claude-code", "codex", "generic", "github-pull-request"]),
        sessionId: z.string().min(1),
        messageIndex: z.number().int().nonnegative(),
      }),
    }),
  ),
});

export interface AuthorCandidateInput {
  readonly run: RunRequest;
  readonly candidate: Candidate;
}

export interface DiscoveryShardInput {
  readonly run: RunRequest;
  readonly wave: number;
  readonly shardIndex: number;
  readonly shardCount: number;
  readonly targetCounts: Readonly<Record<Difficulty, number>>;
  readonly excludedSourcePrs: readonly number[];
}

export interface EnvironmentAuthoringInput {
  readonly run: RunRequest;
  readonly task: AuthoredTaskDraft;
  readonly diagnostics?: string;
  readonly previousTask?: AuthoredTask;
}

export interface TaskStageInput {
  readonly run: RunRequest;
  readonly task: AuthoredTask;
}

export interface RepairTaskInput extends TaskStageInput {
  readonly review: ArtifactRef;
}

export interface ValidationRepairTaskInput extends TaskStageInput {
  readonly validation: ValidationResult;
}

export interface ExportInput {
  readonly run: RunRequest;
  readonly tasks: readonly AuthoredTask[];
}

export interface SelfBenchActivities {
  collectRunProvenance(run: RunRequest): Promise<ArtifactRef>;
  discoverCandidateShard(input: DiscoveryShardInput): Promise<DiscoveryResult>;
  authorCandidate(input: AuthorCandidateInput): Promise<TaskAuthorOutcome>;
  authorEnvironment(input: EnvironmentAuthoringInput): Promise<AuthorOutcome>;
  preflightEnvironment(input: TaskStageInput): Promise<EnvironmentPreflightResult>;
  validateTask(input: TaskStageInput): Promise<ValidationResult>;
  repairValidationTask(input: ValidationRepairTaskInput): Promise<AuthorOutcome>;
  reviewTask(input: TaskStageInput): Promise<ReviewResult>;
  repairTask(input: RepairTaskInput): Promise<AuthorOutcome>;
  auditTask(input: TaskStageInput): Promise<AuditResult>;
  buildExport(input: ExportInput): Promise<ArtifactRef>;
}

export function createActivities(config: SelfBenchWorkerConfig): SelfBenchActivities {
  const store = createArtifactStore(config.artifact);
  const sandbox = createSandboxExecutor(config.execution);
  return {
    collectRunProvenance: (run) => collectRunProvenance(store, run),
    discoverCandidateShard: (input) => discoverCandidateShard(store, sandbox, input),
    authorCandidate: (input) => authorCandidate(store, sandbox, input),
    authorEnvironment: (input) => authorEnvironment(store, sandbox, input),
    preflightEnvironment: (input) => preflightEnvironment(store, config.harborEnvironment, input),
    validateTask: (input) => validateTask(store, config.harborEnvironment, input),
    repairValidationTask: (input) => repairValidationTask(store, sandbox, input),
    reviewTask: (input) => reviewTask(store, sandbox, input),
    repairTask: (input) => repairTask(store, sandbox, input),
    auditTask: (input) => auditTask(store, input),
    buildExport: (input) => buildExport(store, input),
  };
}

async function collectRunProvenance(store: ArtifactStore, run: RunRequest): Promise<ArtifactRef> {
  return await withActivityHeartbeats(
    "collecting merged GitHub pull requests",
    async ({ signal }) => {
      const [localBytes, token] = await Promise.all([store.get(run.provenance), githubToken()]);
      const local = parseProvenance(localBytes);
      const github = await collectGitHubPullRequestProvenance(run.repository.url, token, signal);
      const messages = combineRunProvenance(run.repository.url, local, github);
      if (messages.length === 0) {
        throw ApplicationFailure.nonRetryable(
          "no sanitized local-session or GitHub pull-request provenance was found",
          "NoProvenance",
        );
      }
      return await store.put(
        `runs/${run.runId}/input/combined-provenance-attempt-${Context.current().info.attempt}.jsonl`,
        Buffer.from(`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`),
        "application/x-ndjson",
      );
    },
  );
}

async function discoverCandidateShard(
  store: ArtifactStore,
  sandbox: SandboxExecutor,
  input: DiscoveryShardInput,
): Promise<DiscoveryResult> {
  const { run } = input;
  if (
    !Number.isInteger(input.wave) ||
    input.wave < 0 ||
    !Number.isInteger(input.shardIndex) ||
    !Number.isInteger(input.shardCount) ||
    Object.values(input.targetCounts).some((count) => !Number.isInteger(count) || count < 0) ||
    Object.values(input.targetCounts).every((count) => count === 0) ||
    input.shardIndex < 0 ||
    input.shardIndex >= input.shardCount
  ) {
    throw ApplicationFailure.nonRetryable(
      `invalid discovery shard ${input.shardIndex}/${input.shardCount}`,
      "InvalidDiscoveryShard",
    );
  }
  Context.current().heartbeat(
    `loading provenance for discovery wave ${input.wave} shard ${input.shardIndex}`,
  );
  const provenanceBytes = await store.get(run.provenance);
  const provenance = parseProvenance(provenanceBytes);
  const shard = provenance.filter(
    (_message, index) => index % input.shardCount === input.shardIndex,
  );
  const shardBytes = Buffer.from(`${shard.map((message) => JSON.stringify(message)).join("\n")}\n`);
  const shardPrefix = `runs/${run.runId}/discovery/wave-${input.wave}/shard-${input.shardIndex}`;
  const attemptPrefix = `${shardPrefix}/attempt-${Context.current().info.attempt}`;
  const checkpointKey = `${shardPrefix}/plan.json`;
  let planBytes = await store.getByKey(checkpointKey);
  let logs: ArtifactRef;
  if (planBytes) {
    logs = await store.put(
      `${attemptPrefix}/checkpoint.log`,
      Buffer.from("reused validated discovery shard checkpoint\n"),
      "text/plain",
    );
  } else {
    const [extension, piAuth, ghToken] = await Promise.all([
      readAsset("src/extensions/discovery.ts"),
      loadPiModelAuth(),
      githubToken(),
    ]);
    Context.current().heartbeat(
      `starting discovery wave ${input.wave} shard ${input.shardIndex} over ${shard.length} messages`,
    );
    const result = await runSandboxWithFailureLog(store, `${attemptPrefix}/modal.log`, () =>
      withActivityHeartbeats(
        `running discovery wave ${input.wave} shard ${input.shardIndex}`,
        (options) =>
          sandbox.run(
            {
              runId: run.runId,
              stage: `discover-${input.wave}-${input.shardIndex}`,
              timeoutMs: DISCOVERY_TIMEOUT_MS,
              inactivityTimeoutMs: AGENT_INACTIVITY_TIMEOUT_MS,
              files: [
                { path: "/work/discovery.ts", contents: extension },
                {
                  path: "/work/excluded-source-prs.json",
                  contents: JSON.stringify(input.excludedSourcePrs),
                },
                { path: "/work/provenance.jsonl", contents: shardBytes },
                { path: "/work/prompt.txt", contents: discoveryShardPrompt(input, shard.length) },
              ],
              outputPaths: ["/work/discovery.json"],
              secrets: {
                ...(piAuth.apiKey ? { OPENAI_API_KEY: piAuth.apiKey } : {}),
                ...(piAuth.authJson ? { SELFBENCH_PI_AUTH_JSON: piAuth.authJson } : {}),
                ...(ghToken ? { GH_TOKEN: ghToken } : {}),
              },
              environment: {
                SOURCE_REPO_URL: run.repository.url,
                SOURCE_COMMIT: run.repository.commit,
                AUTHOR_MODEL: run.authoring.model,
                SELFBENCH_DISCOVERY_EXCLUSIONS: "/work/excluded-source-prs.json",
                SELFBENCH_DISCOVERY_OUTPUT: "/work/discovery.json",
              },
              command: ["bash", "-lc", modalAgentScript("discovery.ts", "submit_discovery")],
            },
            options,
          ),
      ),
    );
    planBytes = result.outputs["/work/discovery.json"];
    logs = await store.put(
      `${attemptPrefix}/modal.log`,
      Buffer.from(`${result.stdout}\n${result.stderr}`),
      "text/plain",
    );
    if (result.exitCode !== 0 || !planBytes) {
      throw new Error(`discovery shard failed in ${result.sandboxId}; log: ${logs.uri}`);
    }
    parseDiscoveryPlan(planBytes, input.targetCounts, input.excludedSourcePrs, run.repository.url);
    await store.put(checkpointKey, planBytes, "application/json");
  }
  return await materializeDiscovery(
    store,
    run,
    shard,
    provenance,
    planBytes,
    logs,
    input.targetCounts,
    input.excludedSourcePrs,
    `${attemptPrefix}/report.json`,
    `w${input.wave}s${input.shardIndex}`,
  );
}

async function materializeDiscovery(
  store: ArtifactStore,
  run: RunRequest,
  provenance: readonly ProvenanceMessage[],
  allProvenance: readonly ProvenanceMessage[],
  planBytes: Uint8Array,
  logs: ArtifactRef,
  maxCandidates: Readonly<Record<Difficulty, number>>,
  excludedSourcePrs: readonly number[],
  reportKey: string,
  candidatePrefix: string,
): Promise<DiscoveryResult> {
  const plan = parseDiscoveryPlan(planBytes, maxCandidates, excludedSourcePrs, run.repository.url);

  const candidates: Candidate[] = [];
  for (const raw of plan.candidates) {
    const message = selectCandidateProvenance(provenance, allProvenance, raw);
    const staged = Buffer.from(
      `${JSON.stringify({ source: message, messages: [{ role: "user", content: message.content }] })}\n`,
    );
    const candidateId = `${candidatePrefix}-${raw.candidateId}`;
    const provenanceRef = await store.put(
      `runs/${run.runId}/provenance/${candidateId}.json`,
      staged,
      "application/json",
    );
    candidates.push(
      candidateSchema.parse({
        ...raw,
        candidateId,
        request: message.content,
        provenance: provenanceRef,
      }),
    );
  }
  const report = await store.put(
    reportKey,
    Buffer.from(`${JSON.stringify({ candidates, logs }, null, 2)}\n`),
    "application/json",
  );
  return { candidates, report };
}

export function selectCandidateProvenance(
  available: readonly ProvenanceMessage[],
  allProvenance: readonly ProvenanceMessage[],
  candidate: {
    readonly candidateId: string;
    readonly sourcePr: number;
    readonly sourceUrl: string;
    readonly provenance: {
      readonly sourceType: ProvenanceMessage["sourceType"];
      readonly sessionId: string;
      readonly messageIndex: number;
    };
  },
): ProvenanceMessage {
  const message = available.find(
    (item) =>
      item.sourceType === candidate.provenance.sourceType &&
      item.sessionId === candidate.provenance.sessionId &&
      item.messageIndex === candidate.provenance.messageIndex,
  );
  if (!message) {
    throw new Error(`candidate ${candidate.candidateId} references unknown provenance`);
  }
  assertProvenanceMatchesPullRequest(
    message,
    candidate.sourcePr,
    candidate.sourceUrl,
    allProvenance,
  );
  return message;
}

function parseDiscoveryPlan(
  planBytes: Uint8Array,
  maxCandidates: Readonly<Record<Difficulty, number>>,
  excludedSourcePrs: readonly number[],
  repositoryUrl: string,
) {
  const plan = discoveryPlanSchema.parse(JSON.parse(Buffer.from(planBytes).toString("utf8")));
  for (const difficulty of ["easy", "medium", "hard"] as const) {
    const actual = plan.candidates.filter(
      (candidate) => candidate.difficulty === difficulty,
    ).length;
    if (actual > maxCandidates[difficulty]) {
      throw new Error(
        `discovery produced ${actual} ${difficulty} candidates; expected at most ${maxCandidates[difficulty]}`,
      );
    }
  }
  const candidateIds = new Set<string>();
  const sourcePrs = new Set<number>();
  const excluded = new Set(excludedSourcePrs);
  for (const candidate of plan.candidates) {
    assertPullRequestBelongsToRepository(repositoryUrl, candidate.sourceUrl, candidate.sourcePr);
    if (candidateIds.has(candidate.candidateId)) {
      throw new Error(`discovery repeated candidate ID ${candidate.candidateId}`);
    }
    if (sourcePrs.has(candidate.sourcePr)) {
      throw new Error(`discovery repeated pull request ${candidate.sourcePr}`);
    }
    if (excluded.has(candidate.sourcePr)) {
      throw new Error(`discovery returned excluded pull request ${candidate.sourcePr}`);
    }
    candidateIds.add(candidate.candidateId);
    sourcePrs.add(candidate.sourcePr);
  }
  return plan;
}

async function authorCandidate(
  store: ArtifactStore,
  sandbox: SandboxExecutor,
  input: AuthorCandidateInput,
): Promise<TaskAuthorOutcome> {
  const { run, candidate } = input;
  Context.current().heartbeat(`authoring ${candidate.candidateId}`);
  const checkpointPrefix = `runs/${run.runId}/authoring/${candidate.candidateId}`;
  const [definitionCheckpoint, sourceCheckpoint] = await Promise.all([
    store.getByKey(`${checkpointPrefix}/definition.json`),
    store.getByKey(`${checkpointPrefix}/source-task.tar.gz`),
  ]);
  if (definitionCheckpoint || sourceCheckpoint) {
    if (!definitionCheckpoint || !sourceCheckpoint) {
      throw new Error(`incomplete authoring checkpoint for ${candidate.candidateId}`);
    }
    return await materializeAuthoredTaskDraft(
      store,
      run,
      candidate,
      definitionCheckpoint,
      sourceCheckpoint,
    );
  }
  const [provenance, extension, skill, compiler, piAuth, ghToken] = await Promise.all([
    store.get(candidate.provenance),
    readAsset("src/extensions/authoring.ts"),
    readAsset("src/skills/selfbench/SKILL.md"),
    readAsset("dist/sandbox-author.bundle.js"),
    loadPiModelAuth(),
    githubToken(),
  ]);
  const prompt = authoringPrompt(run, candidate);
  const attemptLogKey = `runs/${run.runId}/authoring/${candidate.candidateId}/attempt-${Context.current().info.attempt}/modal.log`;
  const result = await runSandboxWithFailureLog(store, attemptLogKey, () =>
    withActivityHeartbeats(`running author sandbox for ${candidate.candidateId}`, (options) =>
      sandbox.run(
        {
          runId: run.runId,
          stage: `author-${candidate.candidateId}`,
          timeoutMs: AUTHORING_TIMEOUT_MS,
          inactivityTimeoutMs: AGENT_INACTIVITY_TIMEOUT_MS,
          files: [
            { path: "/work/authoring.ts", contents: extension },
            { path: "/work/selfbench-skill/SKILL.md", contents: skill },
            { path: "/work/sandbox-author.js", contents: compiler },
            { path: "/work/provenance.json", contents: provenance },
            { path: "/work/prompt.txt", contents: prompt },
          ],
          outputPaths: ["/work/source-task.tar.gz", "/work/definition.json"],
          secrets: {
            ...(piAuth.apiKey ? { OPENAI_API_KEY: piAuth.apiKey } : {}),
            ...(piAuth.authJson ? { SELFBENCH_PI_AUTH_JSON: piAuth.authJson } : {}),
            ...(ghToken ? { GH_TOKEN: ghToken } : {}),
          },
          environment: {
            SOURCE_REPO_URL: run.repository.url,
            SOURCE_COMMIT: run.repository.commit,
            AUTHOR_MODEL: run.authoring.model,
            SELFBENCH_TASK_OUTPUT: "/work/tasks",
          },
          command: ["bash", "-lc", authoringScript()],
        },
        options,
      ),
    ),
  );
  const log = await store.put(
    attemptLogKey,
    Buffer.from(`${result.stdout}\n${result.stderr}`),
    "text/plain",
  );
  const bundle = result.outputs["/work/source-task.tar.gz"];
  const definitionBytes = result.outputs["/work/definition.json"];
  if (result.exitCode !== 0 || !bundle || !definitionBytes) {
    return {
      kind: "rejected",
      candidateId: candidate.candidateId,
      reason: `authoring did not produce a valid ${candidate.difficulty} task; log: ${log.uri}`,
    };
  }
  return await materializeAuthoredTaskDraft(store, run, candidate, definitionBytes, bundle);
}

async function materializeAuthoredTaskDraft(
  store: ArtifactStore,
  run: RunRequest,
  candidate: Candidate,
  definitionBytes: Uint8Array,
  bundle: Uint8Array,
): Promise<TaskAuthorOutcome> {
  const definition = taskDraftDefinitionSchema.parse(
    JSON.parse(Buffer.from(definitionBytes).toString("utf8")),
  );
  if (
    definition.sourcePr !== candidate.sourcePr ||
    definition.baseCommit !== candidate.baseCommit ||
    definition.difficulty !== candidate.difficulty
  ) {
    return {
      kind: "rejected",
      candidateId: candidate.candidateId,
      reason: "authored task does not match its assigned PR, base commit, and difficulty",
    };
  }
  const [definitionRef, bundleRef] = await Promise.all([
    store.put(
      `runs/${run.runId}/authoring/${candidate.candidateId}/definition.json`,
      definitionBytes,
      "application/json",
    ),
    store.put(
      `runs/${run.runId}/authoring/${candidate.candidateId}/source-task.tar.gz`,
      bundle,
      "application/gzip",
    ),
  ]);
  return {
    kind: "authored",
    task: {
      candidateId: candidate.candidateId,
      taskId: definition.taskId,
      definition: definitionRef,
      sourceBundle: bundleRef,
    },
  };
}

async function authorEnvironment(
  store: ArtifactStore,
  sandbox: SandboxExecutor,
  input: EnvironmentAuthoringInput,
): Promise<AuthorOutcome> {
  const revision = input.previousTask?.definition.sha256.slice(0, 12) ?? "initial";
  const checkpointPrefix = `runs/${input.run.runId}/environments/${input.task.taskId}/${input.task.sourceBundle.sha256.slice(0, 12)}/${revision}`;
  const [definitionCheckpoint, bundleCheckpoint] = await Promise.all([
    store.getByKey(`${checkpointPrefix}/definition.json`),
    store.getByKey(`${checkpointPrefix}/harbor-task.tar.gz`),
  ]);
  if (definitionCheckpoint || bundleCheckpoint) {
    if (!definitionCheckpoint || !bundleCheckpoint) {
      throw new Error(`incomplete environment checkpoint for ${input.task.taskId}`);
    }
    return await materializeEnvironmentTask(
      store,
      input,
      checkpointPrefix,
      definitionCheckpoint,
      bundleCheckpoint,
    );
  }

  const [draftBytes, sourceBundle, extension, compiler, piAuth, ghToken, previousBytes] =
    await Promise.all([
      store.get(input.task.definition),
      store.get(input.task.sourceBundle),
      readAsset("src/extensions/environment.ts"),
      readAsset("dist/sandbox-environment.bundle.js"),
      loadPiModelAuth(),
      githubToken(),
      input.previousTask ? store.get(input.previousTask.definition) : undefined,
    ]);
  const draft = taskDraftDefinitionSchema.parse(
    JSON.parse(Buffer.from(draftBytes).toString("utf8")),
  );
  const previousDefinition = previousBytes
    ? taskDefinitionSchema.parse(JSON.parse(Buffer.from(previousBytes).toString("utf8")))
    : undefined;
  const prompt = environmentAuthoringPrompt({
    definition: draft,
    ...(previousDefinition ? { original: previousDefinition.environment } : {}),
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  });
  const attemptPrefix = `${checkpointPrefix}/attempt-${Context.current().info.attempt}`;
  const result = await runSandboxWithFailureLog(store, `${attemptPrefix}/sandbox.log`, () =>
    withActivityHeartbeats(`authoring environment for ${input.task.taskId}`, (options) =>
      sandbox.run(
        {
          runId: input.run.runId,
          stage: `environment-${input.task.taskId}-${revision}`,
          timeoutMs: AUTHORING_TIMEOUT_MS,
          inactivityTimeoutMs: AGENT_INACTIVITY_TIMEOUT_MS,
          files: [
            { path: "/work/environment.ts", contents: extension },
            { path: "/work/sandbox-environment.js", contents: compiler },
            { path: "/work/source-task.tar.gz", contents: sourceBundle },
            { path: "/work/draft-definition.json", contents: draftBytes },
            { path: "/work/prompt.txt", contents: prompt },
          ],
          outputPaths: ["/work/task.tar.gz", "/work/definition.json"],
          secrets: {
            ...(piAuth.apiKey ? { OPENAI_API_KEY: piAuth.apiKey } : {}),
            ...(piAuth.authJson ? { SELFBENCH_PI_AUTH_JSON: piAuth.authJson } : {}),
            ...(ghToken ? { GH_TOKEN: ghToken } : {}),
          },
          environment: {
            SOURCE_REPO_URL: input.run.repository.url,
            SOURCE_COMMIT: draft.baseCommit,
            AUTHOR_MODEL: input.run.authoring.model,
            SELFBENCH_ENVIRONMENT_OUTPUT: "/work/environment-output",
          },
          command: ["bash", "-lc", environmentScript()],
        },
        options,
      ),
    ),
  );
  const logs = await store.put(
    `${attemptPrefix}/sandbox.log`,
    Buffer.from(`${result.stdout}\n${result.stderr}`),
    "text/plain",
  );
  const bundle = result.outputs["/work/task.tar.gz"];
  const definitionBytes = result.outputs["/work/definition.json"];
  if (result.exitCode !== 0 || !bundle || !definitionBytes) {
    return {
      kind: "rejected",
      candidateId: input.task.candidateId,
      reason: `environment authoring failed in ${result.sandboxId}; log: ${logs.uri}`,
    };
  }
  return await materializeEnvironmentTask(store, input, checkpointPrefix, definitionBytes, bundle);
}

async function materializeEnvironmentTask(
  store: ArtifactStore,
  input: EnvironmentAuthoringInput,
  checkpointPrefix: string,
  definitionBytes: Uint8Array,
  bundle: Uint8Array,
): Promise<AuthorOutcome> {
  const [draftBytes, previousBytes] = await Promise.all([
    store.get(input.task.definition),
    input.previousTask ? store.get(input.previousTask.definition) : undefined,
  ]);
  const draft = taskDraftDefinitionSchema.parse(
    JSON.parse(Buffer.from(draftBytes).toString("utf8")),
  );
  const definition = taskDefinitionSchema.parse(
    JSON.parse(Buffer.from(definitionBytes).toString("utf8")),
  );
  const { environment: _environment, ...compiledDraft } = definition;
  if (JSON.stringify(compiledDraft) !== JSON.stringify(draft)) {
    throw new Error("environment authoring changed task semantics");
  }
  assertEnvironmentPolicy(definition.environment);
  if (previousBytes) {
    const previous = taskDefinitionSchema.parse(
      JSON.parse(Buffer.from(previousBytes).toString("utf8")),
    );
    assertEnvironmentOnlyRepair(previous, definition);
  }
  const [definitionRef, bundleRef] = await Promise.all([
    store.put(`${checkpointPrefix}/definition.json`, definitionBytes, "application/json"),
    store.put(`${checkpointPrefix}/harbor-task.tar.gz`, bundle, "application/gzip"),
  ]);
  return {
    kind: "authored",
    task: {
      candidateId: input.task.candidateId,
      taskId: definition.taskId,
      definition: definitionRef,
      sourceBundle: input.task.sourceBundle,
      bundle: bundleRef,
    },
  };
}

async function preflightEnvironment(
  store: ArtifactStore,
  harborEnvironment: SelfBenchConfig["harborEnvironment"],
  input: TaskStageInput,
): Promise<EnvironmentPreflightResult> {
  const prefix = `runs/${input.run.runId}/environment-preflights/${input.task.taskId}/${input.task.definition.sha256.slice(0, 12)}/attempt-${Context.current().info.attempt}`;
  return await withTaskBundle(store, input.task, async (taskDirectory, root) => {
    await writeFile(join(taskDirectory, "tests/test.sh"), environmentPreflightScript());
    let accepted = false;
    let reason: string | undefined;
    let result: HarborJobResult | undefined;
    try {
      result = await withActivityHeartbeats(
        `preflighting environment for ${input.task.taskId}`,
        (options) =>
          runHarborGate(
            taskDirectory,
            join(root, "jobs"),
            "nop",
            `${input.task.taskId}-environment-preflight`,
            harborEnvironment,
            options.signal,
            false,
          ),
      );
      const checks = rewards(result.trial);
      accepted = !exception(result.trial) && numberValue(checks.reward) >= 1;
      if (!accepted) {
        reason = boundedTail(
          verifierOutput(result) ?? "environment smoke command failed without output",
        );
      }
    } catch (error) {
      if (
        error instanceof CancelledFailure ||
        (error instanceof ApplicationFailure && error.type === HARBOR_INFRASTRUCTURE_FAILURE_TYPE)
      ) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (!isRepairableEnvironmentFailure(message)) {
        throw error;
      }
      reason = boundedTail(message);
    }
    const report = await store.put(
      `${prefix}/report.json`,
      Buffer.from(
        `${JSON.stringify(
          {
            schemaVersion: 1,
            taskId: input.task.taskId,
            accepted,
            ...(reason ? { reason } : {}),
            ...(result ? { job: result.job, trial: result.trial, verifier: result.verifier } : {}),
          },
          null,
          2,
        )}\n`,
      ),
      "application/json",
    );
    return {
      taskId: input.task.taskId,
      accepted,
      report,
      ...(reason ? { reason } : {}),
    };
  });
}

async function validateTask(
  store: ArtifactStore,
  harborEnvironment: SelfBenchConfig["harborEnvironment"],
  input: TaskStageInput,
): Promise<ValidationResult> {
  const attemptPrefix = `runs/${input.run.runId}/validation/${input.task.taskId}/${input.task.bundle.sha256.slice(0, 12)}/attempt-${Context.current().info.attempt}`;
  return await withTaskBundle(store, input.task, async (taskDirectory, root) => {
    Context.current().heartbeat(`running Harbor nop for ${input.task.taskId}`);
    const nop = await withActivityHeartbeats(
      `running Harbor nop for ${input.task.taskId}`,
      (options) =>
        runHarborGate(
          taskDirectory,
          join(root, "jobs"),
          "nop",
          input.task.taskId,
          harborEnvironment,
          options.signal,
        ),
    );
    Context.current().heartbeat(`running Harbor oracle for ${input.task.taskId}`);
    const oracle = await withActivityHeartbeats(
      `running Harbor oracle for ${input.task.taskId}`,
      (options) =>
        runHarborGate(
          taskDirectory,
          join(root, "jobs"),
          "oracle",
          input.task.taskId,
          harborEnvironment,
          options.signal,
        ),
    );
    const nopChecks = rewards(nop.trial);
    const oracleChecks = rewards(oracle.trial);
    const nopPassed =
      !exception(nop.trial) &&
      numberValue(nopChecks.fail_to_pass) === 0 &&
      numberValue(nopChecks.pass_to_pass) >= 1 &&
      numberValue(nopChecks.setup_completed) >= 1;
    const oraclePassed =
      !exception(oracle.trial) &&
      numberValue(oracleChecks.patch_applied) >= 1 &&
      numberValue(oracleChecks.fail_to_pass) >= 1 &&
      numberValue(oracleChecks.pass_to_pass) >= 1 &&
      numberValue(oracleChecks.deterministic) >= 1 &&
      numberValue(oracleChecks.setup_completed) >= 1;
    const nopOutput = verifierOutput(nop);
    const oracleOutput = verifierOutput(oracle);
    const [nopRef, oracleRef, nopOutputRef, oracleOutputRef] = await Promise.all([
      store.put(
        `${attemptPrefix}/nop.json`,
        Buffer.from(`${JSON.stringify({ job: nop.job, trial: nop.trial }, null, 2)}\n`),
        "application/json",
      ),
      store.put(
        `${attemptPrefix}/oracle.json`,
        Buffer.from(`${JSON.stringify({ job: oracle.job, trial: oracle.trial }, null, 2)}\n`),
        "application/json",
      ),
      nopOutput
        ? store.put(`${attemptPrefix}/nop-verifier.log`, Buffer.from(nopOutput), "text/plain")
        : undefined,
      oracleOutput
        ? store.put(`${attemptPrefix}/oracle-verifier.log`, Buffer.from(oracleOutput), "text/plain")
        : undefined,
    ]);
    return {
      taskId: input.task.taskId,
      accepted: nopPassed && oraclePassed,
      nop: {
        passed: nopPassed,
        result: nopRef,
        ...(nopOutputRef ? { output: nopOutputRef } : {}),
      },
      oracle: {
        passed: oraclePassed,
        result: oracleRef,
        ...(oracleOutputRef ? { output: oracleOutputRef } : {}),
      },
      ...(!nopPassed || !oraclePassed
        ? {
            reason: harborGateFailureReason(
              nopPassed,
              nopChecks,
              oraclePassed,
              oracleChecks,
              nopOutput,
              oracleOutput,
            ),
          }
        : {}),
    };
  });
}

async function repairValidationTask(
  store: ArtifactStore,
  sandbox: SandboxExecutor,
  input: ValidationRepairTaskInput,
): Promise<AuthorOutcome> {
  Context.current().heartbeat(`repairing validation harness for ${input.task.taskId}`);
  const checkpointPrefix = `runs/${input.run.runId}/validation-repairs/${input.task.taskId}/${input.task.bundle.sha256.slice(0, 12)}`;
  const [definitionCheckpoint, bundleCheckpoint] = await Promise.all([
    store.getByKey(`${checkpointPrefix}/definition.json`),
    store.getByKey(`${checkpointPrefix}/harbor-task.tar.gz`),
  ]);
  if (definitionCheckpoint || bundleCheckpoint) {
    if (!definitionCheckpoint || !bundleCheckpoint) {
      throw new Error(`incomplete validation repair checkpoint for ${input.task.taskId}`);
    }
    const definition = taskDefinitionSchema.parse(
      JSON.parse(Buffer.from(definitionCheckpoint).toString("utf8")),
    );
    return {
      kind: "authored",
      task: {
        ...input.task,
        taskId: definition.taskId,
        definition: await store.put(
          `${checkpointPrefix}/definition.json`,
          definitionCheckpoint,
          "application/json",
        ),
        bundle: await store.put(
          `${checkpointPrefix}/harbor-task.tar.gz`,
          bundleCheckpoint,
          "application/gzip",
        ),
      },
    };
  }

  const attemptPrefix = `${checkpointPrefix}/attempt-${Context.current().info.attempt}`;
  const [bundle, definition, repairer, authJson] = await Promise.all([
    store.get(input.task.bundle),
    store.get(input.task.definition),
    readAsset("dist/sandbox-validation-repair.bundle.js"),
    loadPiModelAuth(),
  ]); // Full verifier logs remain durable artifacts. The validation reason already carries bounded
  // tails for failed gates, which keeps the repair prompt within the model context window.
  const diagnostics = Buffer.from(input.validation.reason ?? "validation failed without a reason");
  const result = await withActivityHeartbeats(
    `running validation repair sandbox for ${input.task.taskId}`,
    (options) =>
      sandbox.run(
        {
          runId: input.run.runId,
          stage: `validation-repair-${input.task.taskId}`,
          timeoutMs: 2 * 60 * 60 * 1000,
          inactivityTimeoutMs: AGENT_INACTIVITY_TIMEOUT_MS,
          files: [
            { path: "/work/task.tar.gz", contents: bundle },
            { path: "/work/original-definition.json", contents: definition },
            { path: "/work/validation-diagnostics.txt", contents: diagnostics },
            { path: "/work/sandbox-validation-repair.js", contents: repairer },
          ],
          outputPaths: [
            "/work/repaired-definition.json",
            "/work/repaired-test.patch",
            "/work/repair-report.json",
          ],
          secrets: {
            ...(authJson.apiKey ? { OPENAI_API_KEY: authJson.apiKey } : {}),
            ...(authJson.authJson ? { SELFBENCH_PI_AUTH_JSON: authJson.authJson } : {}),
          },
          environment: { SELFBENCH_REPAIR_MODEL: input.run.authoring.model },
          command: [
            "node",
            "/work/sandbox-validation-repair.js",
            "/work/task.tar.gz",
            "/work/original-definition.json",
            "/work/validation-diagnostics.txt",
            "/work/repaired-definition.json",
            "/work/repaired-test.patch",
            "/work/repair-report.json",
          ],
        },
        options,
      ),
  );
  const repairedDefinition = result.outputs["/work/repaired-definition.json"];
  const repairedTestPatch = result.outputs["/work/repaired-test.patch"];
  const repairReport = result.outputs["/work/repair-report.json"];
  const logs = await store.put(
    `${attemptPrefix}/sandbox.log`,
    Buffer.from(`${result.stdout}\n${result.stderr}`),
    "text/plain",
  );
  if (result.exitCode !== 0 || !repairedDefinition || !repairedTestPatch || !repairReport) {
    return {
      kind: "rejected",
      candidateId: input.task.candidateId,
      reason: `validation repair failed in ${result.sandboxId}; log: ${logs.uri}`,
    };
  }
  const parsedDefinition = taskDefinitionSchema.parse(
    JSON.parse(Buffer.from(repairedDefinition).toString("utf8")),
  );
  const repairedBundle = await withTaskBundle(store, input.task, async (taskDirectory, root) => {
    await writeFile(join(taskDirectory, "tests/test.patch"), repairedTestPatch);
    await refreshHarborTask(taskDirectory, parsedDefinition);
    const output = join(root, "repaired-task.tar.gz");
    await runCommand("tar", ["-czf", output, "-C", root, "harbor-task"]);
    return await readFile(output);
  });
  await store.put(`${attemptPrefix}/report.json`, repairReport, "application/json");
  const [definitionRef, bundleRef] = await Promise.all([
    store.put(`${checkpointPrefix}/definition.json`, repairedDefinition, "application/json"),
    store.put(`${checkpointPrefix}/harbor-task.tar.gz`, repairedBundle, "application/gzip"),
  ]);
  return {
    kind: "authored",
    task: { ...input.task, definition: definitionRef, bundle: bundleRef },
  };
}

async function reviewTask(
  store: ArtifactStore,
  sandbox: SandboxExecutor,
  input: TaskStageInput,
): Promise<ReviewResult> {
  const reportKey = `runs/${input.run.runId}/reviews/${input.task.taskId}/${input.task.bundle.sha256.slice(0, 12)}/attempt-${Context.current().info.attempt}.json`;
  return await withTaskBundle(store, input.task, async (taskDirectory, root) => {
    Context.current().heartbeat(`reviewing ${input.task.taskId}`);
    const [definitionBytes, testPatch, goldPatch] = await Promise.all([
      store.get(input.task.definition),
      readFile(join(taskDirectory, "tests/test.patch")),
      readFile(join(taskDirectory, "solution/gold.patch")),
    ]);
    const definition = taskDefinitionSchema.parse(
      JSON.parse(Buffer.from(definitionBytes).toString("utf8")),
    );
    const testPatchText = testPatch.toString("utf8");
    const goldPatchText = goldPatch.toString("utf8");
    const baseDirectory = join(root, "review-base");
    await mkdir(baseDirectory);
    await runCommand("tar", [
      "-xzf",
      join(taskDirectory, "environment/repo.tar.gz"),
      "-C",
      baseDirectory,
    ]);
    const candidates = discoverContractArtifacts(testPatchText);
    const baseArtifacts = await scanBaseContractArtifacts(baseDirectory, root, candidates);
    const couplingEvidence = buildCouplingEvidence({
      prompt: definition.prompt,
      testPatch: testPatchText,
      goldPatch: goldPatchText,
      baseArtifacts,
    });
    const [reviewer, authJson] = await Promise.all([
      readAsset("dist/sandbox-review.bundle.js"),
      loadPiModelAuth(),
    ]);
    const result = await withActivityHeartbeats(
      `running sandboxed coupling review for ${input.task.taskId}`,
      (options) =>
        sandbox.run(
          {
            runId: input.run.runId,
            stage: `review-${input.task.taskId}`,
            timeoutMs: 15 * 60 * 1000,
            inactivityTimeoutMs: REVIEW_INACTIVITY_TIMEOUT_MS,
            files: [
              { path: "/work/sandbox-review.js", contents: reviewer },
              {
                path: "/work/review-input.md",
                contents: couplingReviewInput(
                  definition.prompt,
                  testPatchText,
                  goldPatchText,
                  couplingEvidence,
                ),
              },
            ],
            outputPaths: ["/work/review.json"],
            secrets: {
              ...(authJson.apiKey ? { OPENAI_API_KEY: authJson.apiKey } : {}),
              ...(authJson.authJson ? { SELFBENCH_PI_AUTH_JSON: authJson.authJson } : {}),
            },
            environment: { SELFBENCH_REVIEW_OUTPUT: "/work/review.json" },
            command: ["node", "/work/sandbox-review.js"],
          },
          options,
        ),
    );
    const output = result.outputs["/work/review.json"];
    if (result.exitCode !== 0 || !output) {
      throw new Error(
        `sandboxed coupling review failed in ${result.sandboxId}: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    const review = couplingReviewSchema.parse(JSON.parse(Buffer.from(output).toString("utf8")));
    const resolution = resolveCouplingReview(couplingEvidence, review);
    const report = await store.put(
      reportKey,
      Buffer.from(
        `${JSON.stringify(
          {
            ...review,
            verdict: resolution.verdict,
            reason: resolution.reason,
            reviewer: COUPLING_REVIEW_MODEL,
            sandboxId: result.sandboxId,
            couplingEvidence,
          },
          null,
          2,
        )}\n`,
      ),
      "application/json",
    );
    return {
      taskId: input.task.taskId,
      accepted: resolution.verdict === "clean",
      report,
      ...(resolution.verdict !== "clean" ? { reason: resolution.reason } : {}),
    };
  });
}

async function repairTask(
  store: ArtifactStore,
  sandbox: SandboxExecutor,
  input: RepairTaskInput,
): Promise<AuthorOutcome> {
  Context.current().heartbeat(`repairing held-out tests for ${input.task.taskId}`);
  const checkpointPrefix = `runs/${input.run.runId}/repairs/${input.task.taskId}`;
  const attemptPrefix = `${checkpointPrefix}/attempt-${Context.current().info.attempt}`;
  const checkpoint = await store.getByKey(`${checkpointPrefix}/harbor-task.tar.gz`);
  if (checkpoint) {
    return {
      kind: "authored",
      task: {
        ...input.task,
        bundle: await store.put(
          `${checkpointPrefix}/harbor-task.tar.gz`,
          checkpoint,
          "application/gzip",
        ),
      },
    };
  }
  const [bundle, review, repairer, authJson] = await Promise.all([
    store.get(input.task.bundle),
    store.get(input.review),
    readAsset("dist/sandbox-repair.bundle.js"),
    loadCodexModelAuth(),
  ]);
  const result = await withActivityHeartbeats(
    `running test repair sandbox for ${input.task.taskId}`,
    (options) =>
      sandbox.run(
        {
          runId: input.run.runId,
          stage: `repair-${input.task.taskId}`,
          timeoutMs: 2 * 60 * 60 * 1000,
          inactivityTimeoutMs: AGENT_INACTIVITY_TIMEOUT_MS,
          files: [
            { path: "/work/task.tar.gz", contents: bundle },
            { path: "/work/review.json", contents: review },
            { path: "/work/sandbox-repair.js", contents: repairer },
          ],
          outputPaths: ["/work/repaired-task.tar.gz", "/work/repair-report.json"],
          secrets: {
            ...(authJson.apiKey ? { OPENAI_API_KEY: authJson.apiKey } : {}),
            ...(authJson.authJson ? { SELFBENCH_CODEX_AUTH_JSON: authJson.authJson } : {}),
          },
          environment: { SELFBENCH_REPAIR_MODEL: input.run.authoring.model },
          command: [
            "node",
            "/work/sandbox-repair.js",
            "/work/task.tar.gz",
            "/work/review.json",
            "/work/repaired-task.tar.gz",
            "/work/repair-report.json",
          ],
        },
        options,
      ),
  );
  const repairedBundle = result.outputs["/work/repaired-task.tar.gz"];
  const repairReport = result.outputs["/work/repair-report.json"];
  const logs = await store.put(
    `${attemptPrefix}/sandbox.log`,
    Buffer.from(`${result.stdout}\n${result.stderr}`),
    "text/plain",
  );
  if (result.exitCode !== 0 || !repairedBundle || !repairReport) {
    return {
      kind: "rejected",
      candidateId: input.task.candidateId,
      reason: `test repair failed in ${result.sandboxId}; log: ${logs.uri}`,
    };
  }
  await store.put(`${attemptPrefix}/report.json`, repairReport, "application/json");
  const repairedRef = await store.put(
    `${checkpointPrefix}/harbor-task.tar.gz`,
    repairedBundle,
    "application/gzip",
  );
  return { kind: "authored", task: { ...input.task, bundle: repairedRef } };
}

async function auditTask(store: ArtifactStore, input: TaskStageInput): Promise<AuditResult> {
  return await withTaskBundle(store, input.task, async (taskDirectory) => {
    const [definitionBytes, goldPatch, testPatch] = await Promise.all([
      store.get(input.task.definition),
      readFile(join(taskDirectory, "solution/gold.patch"), "utf8"),
      readFile(join(taskDirectory, "tests/test.patch"), "utf8"),
    ]);
    const definition = taskDefinitionSchema.parse(
      JSON.parse(Buffer.from(definitionBytes).toString("utf8")),
    );
    const audit = auditTaskDefinition(definition, goldPatch, testPatch);
    const report = await store.put(
      `runs/${input.run.runId}/audits/${input.task.taskId}/${input.task.bundle.sha256.slice(0, 12)}.json`,
      Buffer.from(`${JSON.stringify(audit, null, 2)}\n`),
      "application/json",
    );
    return {
      taskId: input.task.taskId,
      accepted: audit.accepted,
      report,
      ...(audit.accepted ? {} : { reason: audit.blockers.join("; ") }),
    };
  });
}

async function buildExport(store: ArtifactStore, input: ExportInput): Promise<ArtifactRef> {
  return await withTemporaryDirectory("selfbench-export-", async (root) => {
    const tasksRoot = join(root, "tasks");
    await mkdir(tasksRoot, { recursive: true });
    const manifestTasks: { taskId: string; sha256: string }[] = [];
    for (const task of input.tasks) {
      const bundle = await store.get(task.bundle);
      const path = join(tasksRoot, `${task.taskId}.tar.gz`);
      const expanded = join(root, `expanded-${task.taskId}`);
      const sourceArchive = join(expanded, "source.tar.gz");
      await mkdir(expanded, { recursive: true });
      await writeFile(sourceArchive, bundle);
      await runCommand("tar", ["-xzf", sourceArchive, "-C", expanded]);
      const definition = taskDefinitionSchema.parse(
        JSON.parse(Buffer.from(await store.get(task.definition)).toString("utf8")),
      );
      await refreshHarborTask(join(expanded, "harbor-task"), definition);
      await runCommand("tar", ["-czf", path, "-C", expanded, "harbor-task"]);
      manifestTasks.push({ taskId: task.taskId, sha256: sha256(await readFile(path)) });
    }
    await writeFile(
      join(root, "manifest.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          runId: input.run.runId,
          candidateCounts: input.run.candidateCounts,
          repository: input.run.repository,
          version: input.run.version,
          acceptedCount: manifestTasks.length,
          tasks: manifestTasks,
        },
        null,
        2,
      )}\n`,
    );
    const archive = join(root, "export.tar.gz");
    await runCommand("tar", ["-czf", archive, "-C", root, "manifest.json", "tasks"]);
    return await store.putFile(
      `runs/${input.run.runId}/export/attempt-${Context.current().info.attempt}/selfbench-${input.run.runId}.tar.gz`,
      archive,
      "application/gzip",
    );
  });
}

function discoveryShardPrompt(input: DiscoveryShardInput, provenanceCount: number): string {
  return `Discover and rank SelfBench candidates from this assigned provenance shard. Return at most easy=${input.targetCounts.easy}, medium=${input.targetCounts.medium}, hard=${input.targetCounts.hard}. Before selecting a pull request, query its number against /work/excluded-source-prs.json with jq; do not print or read the full exclusion list into context. The submit_discovery tool also removes any already-considered pull requests as a final safeguard.

Assign each candidate exactly one difficulty using the separable implementation core, excluding tests, generated code, formatting churn, and unrelated cleanup:
- easy: at least 20 changed implementation lines across at least 1 implementation file, with at least 1 viable fail-to-pass test;
- medium: at least 50 changed implementation lines across at least 2 implementation files, with at least 1 fail-to-pass and 1 pass-to-pass test;
- hard: at least 100 changed implementation lines across at least 3 implementation files, with at least 1 fail-to-pass and 2 pass-to-pass tests.
Choose the highest tier whose thresholds the candidate honestly meets. Every tier also requires focused public behavior, separable held-out tests, deterministic setup, and an authentic pre-implementation request. Prefer stable public APIs, commands, persistence boundaries, or extension seams.

Every candidate must be a pull request from SOURCE_REPO_URL. Repository names or pull requests mentioned inside provenance messages are context only; never follow them into another repository. sourceUrl must be the canonical GitHub pull-request URL for SOURCE_REPO_URL and sourcePr must match its number.

The sanitized corpus at /work/provenance.jsonl contains ${provenanceCount} human requests. Local Pi, Claude Code, and Codex requests are preferred when they clearly correspond to the same change. A local record with sourcePr and sourceUrl has an explicit user-supplied association and may be used only for that PR. Records with sourceType github-pull-request contain the non-bot PR author's exact title and optional body and are valid fallback provenance; they too may be used only for their own sourcePr and sourceUrl. Select provenance only by an exact sourceType, sessionId, and messageIndex present in the corpus. Never invent or reconstruct request text from implementation or tests. Inspect merged PR metadata and diffs with gh and git. Resolve the exact base and completed 40-character commits. Do not modify the repository.

Return fewer candidates when the shard does not contain enough valid requests; an empty candidate list is valid. Call submit_discovery exactly once. Do not return prose after the tool call.`;
}

function authoringPrompt(run: RunRequest, candidate: Candidate): string {
  const tierRequirements = {
    easy: "at least 20 changed implementation lines across at least 1 implementation file, at least 1 fail-to-pass test, and no pass-to-pass minimum",
    medium:
      "at least 50 changed implementation lines across at least 2 implementation files, at least 1 fail-to-pass test, and at least 1 pass-to-pass test",
    hard: "at least 100 changed implementation lines across at least 3 implementation files, at least 1 fail-to-pass test, and at least 2 pass-to-pass tests",
  } as const;
  return `Author exactly one ${candidate.difficulty} SelfBench task for this assigned candidate:

${JSON.stringify(
  {
    sourcePr: candidate.sourcePr,
    sourceUrl: candidate.sourceUrl,
    baseCommit: candidate.baseCommit,
    completedCommit: candidate.completedCommit,
    request: candidate.request,
  },
  null,
  2,
)}

Use only this candidate. Do not discover alternatives and do not run Harbor. Read /work/provenance.json only to verify the supplied authentic request. Inspect the base and completed commits. Split the completed change into a non-test gold patch and a held-out test patch. The task must meet ${candidate.difficulty} mode: ${tierRequirements[candidate.difficulty]}.

Held-out tests must verify public behavior through an existing API, command, persistence boundary, or extension seam. When the request is about an endpoint/provider contract, exercise that boundary instead of manually composing internal translators, context/option builders, or model factories. Do not import gold-specific private helpers/modules or assert exact internal SQL, query counts, schema/index names, object identity, telemetry layout, error wording, endpoint/response shapes, or UI copy/order unless the authentic request explicitly makes that artifact public. Assert requested semantic values rather than larger retained/raw payloads that happen to contain them, and preserve valid adjacent input content unless the request says to discard it. Cover every material behavior in the prompt, including central authorization, error, and UI states. A different correct implementation with different helpers, file boundaries, API presentation, and UI composition must be able to pass; reject the candidate when no stable public seam exists.

Call submit_task exactly once. Its definition must use schemaVersion 2 and difficulty "${candidate.difficulty}". testCommand must contain the literal {tests} exactly once as an unquoted shell argument list, and every selected test path must be supplied only through that placeholder—never quote the whole placeholder, assign it to one scalar, or hard-code a fail-to-pass or pass-to-pass path elsewhere in the command. Use one repository-native test mode and bundler per command rather than chaining equivalent suites or bypassing repository wrappers with a generic runner. The prompt must not mention the PR, commits, patches, test names, or implementation. Inspect repository test scripts and CI only to select the correct test command. Do not submit runtimes, setup commands, system dependencies, services, or any other environment configuration; a separate environment agent owns that contract.

Before submission, verify from repository scripts and the pinned diff that the selected test identifiers belong to one repository-native test command and form the required nop/oracle split. Do not invent a test command when no stable test seam exists. A separate environment agent and backend preflight own dependency setup and executable proof. Default resources are 4 CPU, 8192 MB memory, 20480 MB storage; default timeouts are 900 setup, 2400 agent, 900 tests. Do not return prose after the tool call.

Pinned SelfBench version: ${run.version.selfbenchCommit}.`;
}

function modalAgentScript(extension: string, tool: string): string {
  return `${sandboxBootstrap()}
clone_source
cd /work/repo
run_with_heartbeat pi --print --mode json --no-session --no-approve --no-skills --no-prompt-templates --no-context-files --no-extensions \\
  --extension /work/${extension} --provider "$(model_provider)" --model "$AUTHOR_MODEL" --thinking high \\
  --tools read,bash,grep,find,ls,${tool} "$(cat /work/prompt.txt)"`;
}

function authoringScript(): string {
  return `${sandboxBootstrap()}
clone_source
mkdir -p /work/tasks
cd /work/repo
run_with_heartbeat pi --print --mode json --no-session --no-approve --no-prompt-templates --no-context-files --no-extensions \\
  --skill /work/selfbench-skill --extension /work/authoring.ts \\
  --provider "$(model_provider)" --model "$AUTHOR_MODEL" --thinking high \\
  --tools read,bash,grep,find,ls,submit_task "$(cat /work/prompt.txt)"
node /work/sandbox-author.js /work/tasks /work/source-task.tar.gz /work/definition.json`;
}

function environmentScript(): string {
  return `${sandboxBootstrap()}
clone_source
mkdir -p /work/environment-output
cd /work/repo
run_with_heartbeat pi --print --mode json --no-session --no-approve --no-skills --no-prompt-templates --no-context-files --no-extensions \\
  --extension /work/environment.ts --provider "$(model_provider)" --model "$AUTHOR_MODEL" --thinking high \\
  --tools read,bash,grep,find,ls,submit_environment "$(cat /work/prompt.txt)"
node /work/sandbox-environment.js /work/source-task.tar.gz /work/draft-definition.json \\
  /work/environment-output/environment.json /work/repo /work/task.tar.gz /work/definition.json`;
}

function isRepairableEnvironmentFailure(message: string): boolean {
  return /ImageBuildError|image build|Dockerfile|failed to solve|did not complete successfully|Docker Compose launch failed|service .*(?:unhealthy|failed)|no such file or directory/i.test(
    message,
  );
}

function environmentPreflightScript(): string {
  return `#!/bin/bash
set -uo pipefail
mkdir -p /logs/verifier
smoke_status=0
nop_status=1
output="$(mktemp /tmp/selfbench-environment-smoke-XXXXXX.log)"
runuser -u verifier --preserve-environment -- /opt/selfbench-environment/smoke.sh >"$output" 2>&1 || smoke_status=$?
cat "$output"
rm -f "$output"
if [ "$smoke_status" -eq 0 ]; then
  /tests/task-test.sh
  if grep -q '"patch_applied": 1' /logs/verifier/reward.json \\
    && grep -q '"fail_to_pass": 0' /logs/verifier/reward.json \\
    && grep -q '"pass_to_pass": 1' /logs/verifier/reward.json \\
    && grep -q '"setup_completed": 1' /logs/verifier/reward.json; then
    nop_status=0
  fi
fi
reward=0
if [ "$smoke_status" -eq 0 ] && [ "$nop_status" -eq 0 ]; then reward=1; fi
printf '{"reward": %s, "smoke_exit_code": %s, "nop_exit_code": %s}\n' "$reward" "$smoke_status" "$nop_status" > /logs/verifier/reward.json
exit 0
`;
}

function sandboxBootstrap(): string {
  return `set -euo pipefail
mkdir -p "$HOME/.pi/agent"
if [ -n "\${SELFBENCH_PI_AUTH_JSON:-}" ]; then
  printf '%s' "$SELFBENCH_PI_AUTH_JSON" > "$HOME/.pi/agent/auth.json"
  chmod 600 "$HOME/.pi/agent/auth.json"
fi
printf '%s\n' '{"transport":"auto"}' > "$HOME/.pi/agent/settings.json"
chmod 600 "$HOME/.pi/agent/settings.json"
model_provider() { [ -n "\${OPENAI_API_KEY:-}" ] && printf openai || printf openai-codex; }
run_with_heartbeat() {
  "$@" 2>&1 &
  local command_pid=$!
  (
    while sleep 60; do
      printf '[selfbench] agent process %s still running at %s\n' "$command_pid" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >&2
    done
  ) &
  local heartbeat_pid=$!
  trap 'kill "$command_pid" "$heartbeat_pid" 2>/dev/null || true' TERM INT
  set +e
  wait "$command_pid"
  local command_status=$?
  set -e
  kill "$heartbeat_pid" 2>/dev/null || true
  wait "$heartbeat_pid" 2>/dev/null || true
  trap - TERM INT
  return "$command_status"
}
cleanup() { rm -f "$HOME/.pi/agent/auth.json" "$HOME/.pi/agent/settings.json" "$HOME/.git-credentials"; }
trap cleanup EXIT
clone_source() {
  if [ -n "\${GH_TOKEN:-}" ]; then
    git config --global credential.helper store
    printf 'https://x-access-token:%s@github.com\n' "$GH_TOKEN" > "$HOME/.git-credentials"
    chmod 600 "$HOME/.git-credentials"
  fi
  git clone --no-checkout --filter=blob:none "$SOURCE_REPO_URL" /work/repo
  git -C /work/repo fetch origin "$SOURCE_COMMIT"
  git -C /work/repo checkout --detach "$SOURCE_COMMIT"
}`;
}

async function runHarborGate(
  taskDirectory: string,
  jobsDirectory: string,
  agent: "nop" | "oracle",
  taskId: string,
  environment: SelfBenchConfig["harborEnvironment"],
  signal: AbortSignal,
  quiet = true,
): Promise<HarborJobResult> {
  const jobName = `${taskId}-${agent}-${crypto.randomUUID().slice(0, 8)}`;
  const result = await runCommand(
    "harbor",
    [
      "run",
      "--path",
      taskDirectory,
      "--agent",
      agent,
      "--env",
      environment,
      "--job-name",
      jobName,
      "--jobs-dir",
      jobsDirectory,
      "--delete",
      "--yes",
      ...(quiet ? ["--quiet"] : []),
    ],
    {
      allowFailure: true,
      env: harborChildEnvironment(),
      timeoutMs: 3 * 60 * 60 * 1000,
      signal,
    },
  );
  if (result.exitCode !== 0) {
    throw ApplicationFailure.create({
      message: harborCommandFailureMessage(
        agent,
        taskId,
        result.exitCode,
        `${result.stdout}\n${result.stderr}`,
      ),
      type: HARBOR_INFRASTRUCTURE_FAILURE_TYPE,
    });
  }
  const parsed = await readHarborJobResult(jobsDirectory, jobName);
  const infrastructureError = harborInfrastructureError(parsed.trial);
  if (infrastructureError) {
    throw ApplicationFailure.create({
      message: `Harbor ${agent} infrastructure failure for ${taskId}: ${infrastructureError}`,
      type: HARBOR_INFRASTRUCTURE_FAILURE_TYPE,
    });
  }
  return parsed;
}

function harborCommandFailureMessage(
  agent: "nop" | "oracle",
  taskId: string,
  exitCode: number,
  output: string,
): string {
  const detail = output.trim();
  return `Harbor ${agent} exited ${exitCode} for ${taskId}${detail ? `:\n${boundedTail(detail)}` : ""}`;
}

function harborGateFailureReason(
  nopPassed: boolean,
  nopChecks: Record<string, unknown>,
  oraclePassed: boolean,
  oracleChecks: Record<string, unknown>,
  nopOutput?: string,
  oracleOutput?: string,
): string {
  const formatChecks = (checks: Record<string, unknown>): string =>
    [
      "patch_applied",
      "fail_to_pass",
      "pass_to_pass",
      "deterministic",
      "setup_completed",
      "fail_to_pass_exit_code",
      "fail_to_pass_repeat_exit_code",
      "pass_to_pass_exit_code",
    ]
      .map((key) => `${key}=${String(checks[key] ?? "missing")}`)
      .join(", ");
  const diagnostics = [
    ...(!nopPassed && nopOutput ? [`nop verifier tail:\n${boundedTail(nopOutput)}`] : []),
    ...(!oraclePassed && oracleOutput
      ? [`oracle verifier tail:\n${boundedTail(oracleOutput)}`]
      : []),
  ];
  return `Harbor gates failed: nop=${nopPassed} (${formatChecks(nopChecks)}); oracle=${oraclePassed} (${formatChecks(oracleChecks)})${diagnostics.length > 0 ? `\n${diagnostics.join("\n")}` : ""}`;
}

function verifierOutput(
  result: Awaited<ReturnType<typeof readHarborJobResult>>,
): string | undefined {
  const combined = result.verifier?.combined;
  const stderr = result.verifier?.stderr;
  if (combined && stderr) {
    return `${combined.trimEnd()}\n\n--- verifier stderr ---\n${stderr}`;
  }
  return stderr ?? combined;
}

function boundedTail(value: string, maxBytes = 8_000): string {
  const buffer = Buffer.from(value);
  return buffer.length <= maxBytes
    ? value.trimEnd()
    : `[truncated ${buffer.length - maxBytes} bytes]\n${buffer.subarray(-maxBytes).toString("utf8").trimEnd()}`;
}

async function runSandboxWithFailureLog(
  store: ArtifactStore,
  logKey: string,
  action: () => Promise<SandboxResult>,
): Promise<SandboxResult> {
  try {
    return await action();
  } catch (error) {
    if (!(error instanceof SandboxExecutionError)) {
      throw error;
    }
    const log = await store.put(
      logKey,
      Buffer.from(`${error.result.stdout}\n${error.result.stderr}`),
      "text/plain",
    );
    throw new Error(`${error.message}; partial log: ${log.uri}`, { cause: error });
  }
}

async function withActivityHeartbeats<T>(
  detail: string,
  action: (options: SandboxRunOptions & { readonly signal: AbortSignal }) => Promise<T>,
): Promise<T> {
  const context = Context.current();
  let outputBytes = 0;
  let lastOutputAt: string | undefined;
  const heartbeatDetail = (): {
    detail: string;
    outputBytes: number;
    lastOutputAt?: string;
  } => ({
    detail,
    outputBytes,
    ...(lastOutputAt ? { lastOutputAt } : {}),
  });
  context.heartbeat(heartbeatDetail());
  const heartbeat = setInterval(() => context.heartbeat(heartbeatDetail()), 60_000);
  heartbeat.unref();
  try {
    try {
      const result = await action({
        signal: context.cancellationSignal,
        onProgress: (progress) => {
          outputBytes += progress.bytes;
          lastOutputAt = new Date().toISOString();
        },
      });
      if (context.cancellationSignal.aborted) {
        throw new CancelledFailure("activity cancellation requested");
      }
      return result;
    } catch (error) {
      if (context.cancellationSignal.aborted && !(error instanceof CancelledFailure)) {
        throw new CancelledFailure("activity cancellation requested");
      }
      throw error;
    }
  } finally {
    clearInterval(heartbeat);
  }
}

async function withTaskBundle<T>(
  store: ArtifactStore,
  task: AuthoredTask,
  action: (taskDirectory: string, root: string) => Promise<T>,
): Promise<T> {
  return await withTemporaryDirectory(`selfbench-${task.taskId}-`, async (root) => {
    const archive = join(root, "task.tar.gz");
    await writeFile(archive, await store.get(task.bundle));
    await runCommand("tar", ["-xzf", archive, "-C", root]);
    const taskDirectory = join(root, "harbor-task");
    const definition = taskDefinitionSchema.parse(
      JSON.parse(Buffer.from(await store.get(task.definition)).toString("utf8")),
    );
    await refreshHarborTask(taskDirectory, definition);
    return await action(taskDirectory, root);
  });
}

async function withTemporaryDirectory<T>(
  prefix: string,
  action: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await action(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function parseProvenance(value: Uint8Array): ProvenanceMessage[] {
  return Buffer.from(value)
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => provenanceMessageSchema.parse(JSON.parse(line)));
}

function readAsset(relativePath: string): Promise<Buffer> {
  return readFile(join(projectRoot(import.meta.url), relativePath));
}

function rewards(trial: unknown): Record<string, unknown> {
  if (
    !isRecord(trial) ||
    !isRecord(trial.verifier_result) ||
    !isRecord(trial.verifier_result.rewards)
  ) {
    return {};
  }
  return trial.verifier_result.rewards;
}

function exception(trial: unknown): unknown {
  return isRecord(trial) ? trial.exception_info : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
