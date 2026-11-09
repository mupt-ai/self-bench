import type { ArtifactStore } from "../../artifacts/index.js";
import type { SelfBenchConfig } from "../../contracts/config/index.js";
import type { AuthoredTaskDraft } from "../../contracts/index.js";
import type { TaskRecord, TaskStart } from "../../db/tasks.js";
import type { Vault } from "../../db/vault.js";
import { saveGenerationRecords } from "../settings/credentials.js";
import type { GenerationReference } from "../settings/settings.js";
import {
  scenarioKeys,
  scenarioRunId,
  stageScenario,
  startTaskFromScenario,
} from "./scenario-start.js";
import type { WorkflowStarter } from "./start.js";

/**
 * A scenario task's revision: a new run of the same scenario that keeps the original's candidate,
 * title, tier, attachments, and for a repository scenario its commit, and starts from `stage`'s
 * draft with the person's feedback. `reserve` records it before its workflow starts: as a task
 * row for a revision, or as a variant (variant.ts), whose draft is only checked (`verifyOnly`).
 */
export async function reviseScenario<Row extends { readonly runId: string }>(options: {
  readonly config: SelfBenchConfig;
  readonly artifacts: ArtifactStore;
  readonly start: WorkflowStarter;
  readonly vault?: Vault;
  readonly repository: { readonly id: number; readonly fullName: string };
  readonly task: TaskRecord;
  readonly startedBy: number;
  readonly feedback: string;
  readonly verifyOnly?: boolean;
  readonly reserve: (row: TaskStart) => Promise<Row>;
  readonly stage: (runId: string) => Promise<AuthoredTaskDraft>;
  readonly generation?: GenerationReference;
  /** The person's GitHub token, which a repository scenario's run keeps to clone its commit. */
  readonly token?: string;
}): Promise<Row> {
  const { artifacts, task, repository } = options;
  const title = task.title ?? task.taskId;
  const scenario = await originalScenario(artifacts, task);
  const baseCommit = task.baseCommit;
  const row = await options.reserve({
    repoId: repository.id,
    runId: scenarioRunId(repository.fullName),
    candidateId: task.candidateId,
    taskId: task.taskId,
    title,
    difficulty: task.difficulty,
    ...(baseCommit ? { baseCommit } : {}),
    stage: "authoring",
    startedBy: options.startedBy,
  });
  const attachments = await artifacts.stat(scenarioKeys(task.runId, task.candidateId).attachments);
  const staged = await stageScenario({
    artifacts,
    runId: row.runId,
    candidateId: task.candidateId,
    title,
    scenario,
    difficulty: task.difficulty,
    attachments: attachments ? { ...attachments, contentType: "application/gzip" } : undefined,
    ...(baseCommit ? { baseCommit } : {}),
  });
  if (options.generation && options.vault)
    await saveGenerationRecords(
      options.vault.records,
      row.runId,
      options.generation,
      baseCommit ? options.token : undefined,
    );
  await startTaskFromScenario({
    config: options.config,
    start: options.start,
    repository,
    runId: row.runId,
    ...staged,
    ...(options.generation ? { generation: options.generation } : {}),
    revision: {
      draft: await options.stage(row.runId),
      feedback: options.feedback,
      ...(options.verifyOnly ? { verifyOnly: true } : {}),
    },
  });
  return row;
}

/** The scenario as its run's provenance recorded it; a revision of a revision reads its own. */
async function originalScenario(
  artifacts: ArtifactStore,
  task: Pick<TaskRecord, "runId" | "candidateId" | "taskId">,
): Promise<string> {
  const bytes = await artifacts.getByKey(scenarioKeys(task.runId, task.candidateId).candidate);
  const content = bytes
    ? (JSON.parse(Buffer.from(bytes).toString("utf8")) as { messages?: { content?: unknown }[] })
        .messages?.[0]?.content
    : undefined;
  if (typeof content !== "string" || !content.trim())
    throw new Error(`scenario task ${task.taskId} has no recorded scenario`);
  return content;
}
