import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ArtifactStore } from "../../artifacts/index.js";
import { buildCommit } from "../../contracts/config/build-metadata.js";
import type { SelfBenchConfig } from "../../contracts/config/index.js";
import {
  type ArtifactRef,
  candidateWorkflowId,
  difficultySchema,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_SCENARIO_LENGTH,
  MAX_SCENARIO_TITLE_LENGTH,
  type ScenarioCandidate,
  type TaskRevision,
} from "../../contracts/index.js";
import { runCommand } from "../../lib/process.js";
import { withTemporaryDirectory } from "../../sandbox/temporary.js";
import { buildRunRequest, configureGenerationRun } from "../settings/run.js";
import type { GenerationReference } from "../settings/settings.js";
import type { WorkflowStarter } from "./start.js";

/** The request body limit that fits the largest scenario with its attachments. */
export const SCENARIO_BODY_LIMIT = Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 256 * 1024;

const attachmentNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,119}$/, "attachment names are plain file names");

/** What a person sends to start a scenario task, from the app, the API, or the CLI. */
export const scenarioRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(MAX_SCENARIO_TITLE_LENGTH),
    scenario: z.string().trim().min(1).max(MAX_SCENARIO_LENGTH),
    difficulty: difficultySchema.default("medium"),
    attachments: z
      .array(z.object({ name: attachmentNameSchema, content: z.base64() }).strict())
      .max(MAX_ATTACHMENTS)
      .default([])
      .refine(
        (files) => new Set(files.map((file) => file.name)).size === files.length,
        "attachment names must be unique",
      )
      .refine(
        (files) =>
          files.reduce((total, file) => total + Buffer.byteLength(file.content, "base64"), 0) <=
          MAX_ATTACHMENT_BYTES,
        `attachments may total at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`,
      ),
    generation: z.unknown().optional(),
  })
  .strict();

export type ScenarioRequest = z.infer<typeof scenarioRequestSchema>;

/** Scenario runs are named after their repository; a scenario has no number, so a random suffix. */
export function scenarioRunId(fullName: string): string {
  return `scn-${slug(fullName, 40)}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

/** The candidate, and so the task until its author names it, is named after the title. */
export function scenarioCandidateId(title: string): string {
  return `scenario-${slug(title, 48) || "task"}`;
}

/** The run's provenance and attachments, where a revision finds them again. */
export const scenarioKeys = (runId: string, candidateId: string) => ({
  run: `runs/${runId}/input/provenance.jsonl`,
  candidate: `runs/${runId}/provenance/${candidateId}.json`,
  attachments: `runs/${runId}/input/attachments.tar.gz`,
});

/**
 * Stores the scenario as the pipeline expects a PR's provenance, and packs its attachments in one
 * tarball the author unpacks. The candidate it returns starts a task's workflow.
 */
export async function stageScenario(options: {
  readonly artifacts: ArtifactStore;
  readonly runId: string;
  readonly candidateId: string;
  readonly title: string;
  readonly scenario: string;
  readonly difficulty: ScenarioCandidate["difficulty"];
  /** Files to pack, or a tarball already packed (a revision reuses its original's). */
  readonly attachments: ScenarioRequest["attachments"] | ArtifactRef | undefined;
}): Promise<{ readonly candidate: ScenarioCandidate; readonly runProvenance: ArtifactRef }> {
  const { artifacts, runId, candidateId, title, scenario } = options;
  const keys = scenarioKeys(runId, candidateId);
  const source = { sourceType: "scenario", title, content: scenario };
  const runProvenance = await artifacts.put(
    keys.run,
    Buffer.from(`${JSON.stringify(source)}\n`),
    "application/x-ndjson",
  );
  const provenance = await artifacts.put(
    keys.candidate,
    Buffer.from(`${JSON.stringify({ source, messages: [{ role: "user", content: scenario }] })}\n`),
    "application/json",
  );
  const given = options.attachments;
  const attachments = Array.isArray(given)
    ? given.length > 0
      ? await artifacts.put(keys.attachments, await packAttachments(given), "application/gzip")
      : undefined
    : given
      ? await artifacts.put(keys.attachments, await artifacts.get(given), "application/gzip")
      : undefined;
  return {
    candidate: {
      kind: "scenario",
      candidateId,
      difficulty: options.difficulty,
      title,
      request: scenario,
      provenance,
      ...(attachments ? { attachments } : {}),
    },
    runProvenance,
  };
}

/** Starts the scenario's candidate workflow directly, as a task from Add PRs starts. */
export async function startTaskFromScenario(options: {
  readonly config: SelfBenchConfig;
  readonly start: WorkflowStarter;
  readonly repository: { readonly fullName: string };
  readonly runId: string;
  readonly candidate: ScenarioCandidate;
  readonly runProvenance: ArtifactRef;
  readonly generation?: GenerationReference;
  readonly revision?: TaskRevision;
}): Promise<void> {
  const { config, candidate, runId } = options;
  const run = buildRunRequest(config, {
    runId,
    // A scenario never clones its repository; the run names it only to own the task.
    repository: { url: `https://github.com/${options.repository.fullName}`, commit: NO_COMMIT },
    provenance: options.runProvenance,
    candidateCounts: {
      easy: candidate.difficulty === "easy" ? 1 : 0,
      medium: candidate.difficulty === "medium" ? 1 : 0,
      hard: candidate.difficulty === "hard" ? 1 : 0,
    },
    selfbenchCommit: buildCommit,
  });
  if (options.generation) configureGenerationRun(run, options.generation, config);
  await options.start(candidateWorkflowId(runId, candidate.candidateId), {
    run,
    candidate,
    ...(options.revision ? { revision: options.revision } : {}),
  });
}

const NO_COMMIT = "0".repeat(40);

async function packAttachments(files: ScenarioRequest["attachments"]): Promise<Uint8Array> {
  return await withTemporaryDirectory("selfbench-attachments-", async (root) => {
    const folder = join(root, "files");
    await mkdir(folder);
    await Promise.all(
      files.map((file) => writeFile(join(folder, file.name), Buffer.from(file.content, "base64"))),
    );
    const archive = join(root, "attachments.tar.gz");
    await runCommand("tar", ["-czf", archive, "-C", folder, ...files.map((file) => file.name)]);
    return await readFile(archive);
  });
}

function slug(value: string, length: number): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, length)
    .replace(/-+$/g, "");
}
