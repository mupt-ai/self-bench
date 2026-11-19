import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ArtifactStore } from "../../artifacts/index.js";
import { buildCommit } from "../../contracts/config/build-metadata.js";
import type { SelfBenchConfig } from "../../contracts/config/index.js";
import {
  type AuthoredTaskDraft,
  candidateWorkflowId,
  commitSchema,
  type FeatureCandidate,
  featureCandidateSchema,
} from "../../contracts/index.js";
import type { TaskRecord, TaskStart } from "../../db/tasks.js";
import type { Vault } from "../../db/vault.js";
import { saveGenerationRecords } from "../settings/credentials.js";
import { buildRunRequest, configureGenerationRun } from "../settings/run.js";
import type { GenerationReference } from "../settings/settings.js";
import type { WorkflowStarter } from "./start.js";

/** What discovery recorded of a feature (discovery.ts), which a revision builds its candidate from. */
const recordedFeatureSchema = z.object({
  source: z.object({
    sourceType: z.literal("feature"),
    title: z.string(),
    pullRequests: featureCandidateSchema.shape.pullRequests,
    baseCommit: commitSchema,
    completedCommit: commitSchema,
  }),
  messages: z.array(z.object({ content: z.string().min(1) })).min(1),
});

/** A feature's revision runs under its own run, as a scenario's does. */
function featureRunId(fullName: string): string {
  const slug = fullName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return `feat-${slug}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

/** The feature a task was authored from, as its run's provenance recorded it. */
async function recordedFeature(
  artifacts: ArtifactStore,
  task: Pick<TaskRecord, "runId" | "candidateId" | "taskId">,
): Promise<{ readonly source: z.infer<typeof recordedFeatureSchema>["source"]; request: string }> {
  const bytes = await artifacts.getByKey(`runs/${task.runId}/provenance/${task.candidateId}.json`);
  if (!bytes) throw new Error(`feature task ${task.taskId} has no recorded feature`);
  const recorded = recordedFeatureSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
  return { source: recorded.source, request: recorded.messages[0]?.content ?? "" };
}

/**
 * A feature task's revision: a new run of the same feature, with the same candidate, tier, PRs,
 * and base, that starts from `stage`'s draft with the person's feedback. `reserve` records it
 * before its workflow starts, as a revision's row or a variant's.
 */
export async function reviseFeature<Row extends { readonly runId: string }>(options: {
  readonly config: SelfBenchConfig;
  readonly artifacts: ArtifactStore;
  readonly start: WorkflowStarter;
  readonly vault?: Vault;
  readonly repository: { readonly id: number; readonly fullName: string };
  readonly task: TaskRecord;
  readonly startedBy: number;
  readonly feedback: string;
  readonly verifyOnly?: boolean;
  readonly cacheFrom?: string;
  readonly reserve: (row: TaskStart) => Promise<Row>;
  readonly stage: (runId: string) => Promise<AuthoredTaskDraft>;
  readonly generation?: GenerationReference;
  /** The person's GitHub token, which the run keeps to clone the repository. */
  readonly token?: string;
}): Promise<Row> {
  const { artifacts, task, repository } = options;
  const { source, request } = await recordedFeature(artifacts, task);
  const row = await options.reserve({
    repoId: repository.id,
    runId: featureRunId(repository.fullName),
    candidateId: task.candidateId,
    taskId: task.taskId,
    title: task.title ?? source.title,
    sourcePrs: source.pullRequests.map((pr) => pr.number),
    baseCommit: source.baseCommit,
    difficulty: task.difficulty,
    stage: "authoring",
    startedBy: options.startedBy,
  });
  const provenanceBody = Buffer.from(
    `${JSON.stringify({ source, messages: [{ role: "user", content: request }] })}\n`,
  );
  const runProvenance = await artifacts.put(
    `runs/${row.runId}/input/provenance.jsonl`,
    Buffer.from(`${JSON.stringify(source)}\n`),
    "application/x-ndjson",
  );
  const provenance = await artifacts.put(
    `runs/${row.runId}/provenance/${task.candidateId}.json`,
    provenanceBody,
    "application/json",
  );
  const candidate: FeatureCandidate = featureCandidateSchema.parse({
    kind: "feature",
    candidateId: task.candidateId,
    difficulty: task.difficulty,
    title: task.title ?? source.title,
    request,
    pullRequests: source.pullRequests,
    baseCommit: source.baseCommit,
    completedCommit: source.completedCommit,
    provenance,
  });
  if (options.generation && options.vault)
    await saveGenerationRecords(
      options.vault.records,
      row.runId,
      options.generation,
      options.token,
    );
  const run = buildRunRequest(options.config, {
    runId: row.runId,
    repository: {
      url: `https://github.com/${repository.fullName}`,
      commit: candidate.completedCommit,
    },
    provenance: runProvenance,
    candidateCounts: {
      easy: candidate.difficulty === "easy" ? 1 : 0,
      medium: candidate.difficulty === "medium" ? 1 : 0,
      hard: candidate.difficulty === "hard" ? 1 : 0,
    },
    selfbenchCommit: buildCommit,
  });
  run.unit = "feature";
  if (options.generation) configureGenerationRun(run, options.generation, options.config);
  await options.start(candidateWorkflowId(row.runId, candidate.candidateId), {
    run,
    candidate,
    revision: {
      draft: await options.stage(row.runId),
      feedback: options.feedback,
      ...(options.verifyOnly ? { verifyOnly: true } : {}),
      ...(options.cacheFrom ? { cacheFrom: options.cacheFrom } : {}),
    },
  });
  return row;
}
