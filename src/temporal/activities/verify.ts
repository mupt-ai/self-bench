import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CancelledFailure, Context } from "@temporalio/activity";
import { extractRegularArchive } from "../../archive.js";
import type { ArtifactStore } from "../../artifacts.js";
import { auditTaskDefinition } from "../../audit.js";
import type { SelfBenchConfig } from "../../config.js";
import {
  type AuthoredTask,
  type TaskDefinition,
  taskDefinitionSchema,
  type VerifyOutcome,
  type VerifyReport,
  verifyReportSchema,
} from "../../contracts.js";
import { assertEnvironmentPolicy } from "../../environment.js";
import { githubToken } from "../../subscription-auth.js";
import { isGreen, renderVerifyReport } from "../../verify-report.js";
import { readTaskPatches, withActivityHeartbeats, withTemporaryDirectory } from "./runtime.js";
import { compileSubmittedTask, TaskCompilerInfrastructureError } from "./task-compiler.js";
import type { CompileAndVerifyInput } from "./types.js";
import { notRunGates, runHarborGates } from "./verify-harbor.js";

/**
 * Trusted verification of one submission: schema, candidate identity, environment policy, static
 * audit, the trusted compiler (renders task.toml, Dockerfiles, scripts, and the repo snapshot), and
 * Harbor build/smoke/nop/oracle. Every failure lands in one VerifyReport the agent can act on.
 */
export async function compileAndVerify(
  store: ArtifactStore,
  harborEnvironment: SelfBenchConfig["harborEnvironment"],
  input: CompileAndVerifyInput,
  artifactPrefix?: string,
): Promise<VerifyOutcome> {
  const { run, candidate, stage, round } = input;
  const prefix =
    artifactPrefix ?? `runs/${run.runId}/verify/${candidate.candidateId}/${stage}-round-${round}`;
  const checkpoint = await store.getByKey(`${prefix}/report.json`);
  if (checkpoint) {
    return await restoreCheckpoint(store, prefix, input, checkpoint);
  }
  Context.current().heartbeat(`verifying ${input.task.taskId} (${stage} round ${round})`);
  const [definitionBytes, sourceBundle, ghToken] = await Promise.all([
    store.get(input.task.definition),
    store.get(input.task.sourceBundle),
    githubToken(),
  ]);
  const errors: string[] = [];
  const definition = parseDefinition(definitionBytes, errors);
  if (definition) {
    checkCandidateIdentity(definition, candidate, errors);
    try {
      assertEnvironmentPolicy(definition.environment);
    } catch (error) {
      errors.push(message(error));
    }
  }
  const patches = await withTemporaryDirectory("selfbench-submission-", async (root) => {
    const archive = join(root, "source-task.tar.gz");
    const authored = join(root, "authored");
    await mkdir(authored);
    await writeFile(archive, sourceBundle);
    await extractRegularArchive(archive, authored);
    return await readTaskPatches(authored).catch((error: unknown) => {
      errors.push(`submission bundle is incomplete: ${message(error)}`);
      return undefined;
    });
  });
  const audit =
    definition && patches
      ? auditTaskDefinition(definition, patches.goldPatch, patches.testPatch)
      : {
          accepted: false,
          blockers: ["audit skipped because the definition or patches are invalid"],
        };

  let task: AuthoredTask | undefined;
  if (errors.length === 0 && definition) {
    try {
      const bundle = await withActivityHeartbeats(`compiling ${definition.taskId}`, ({ signal }) =>
        compileSubmittedTask({
          taskId: definition.taskId,
          repositoryUrl: run.repository.url,
          definitionBytes,
          sourceBundle,
          ...(ghToken ? { token: ghToken } : {}),
          signal,
        }),
      );
      const bundleRef = await store.put(`${prefix}/harbor-task.tar.gz`, bundle, "application/gzip");
      task = { ...input.task, taskId: definition.taskId, bundle: bundleRef };
    } catch (error) {
      if (error instanceof CancelledFailure || error instanceof TaskCompilerInfrastructureError) {
        throw error;
      }
      errors.push(message(error));
    }
  }
  const gates =
    task && audit.accepted
      ? await runHarborGates(store, task, harborEnvironment, prefix)
      : notRunGates();
  const partial = {
    schemaVersion: 1 as const,
    stage,
    round,
    taskId: task?.taskId ?? input.task.taskId,
    compile: { ok: errors.length === 0, errors },
    audit: { ok: audit.accepted, blockers: [...audit.blockers] },
    ...gates,
  };
  const report: VerifyReport = { ...partial, green: isGreen(partial) };
  const [reportRef] = await Promise.all([
    store.put(
      `${prefix}/report.json`,
      Buffer.from(`${JSON.stringify(report, null, 2)}\n`),
      "application/json",
    ),
    store.put(`${prefix}/report.md`, Buffer.from(renderVerifyReport(report)), "text/markdown"),
  ]);
  return { report, reportRef, ...(task ? { task } : {}) };
}

async function restoreCheckpoint(
  store: ArtifactStore,
  prefix: string,
  input: CompileAndVerifyInput,
  checkpoint: Uint8Array,
): Promise<VerifyOutcome> {
  const report = verifyReportSchema.parse(JSON.parse(Buffer.from(checkpoint).toString("utf8")));
  const reportRef = await store.put(`${prefix}/report.json`, checkpoint, "application/json");
  if (!report.compile.ok) {
    return { report, reportRef };
  }
  const bundle = await store.getByKey(`${prefix}/harbor-task.tar.gz`);
  if (!bundle) {
    throw new Error(`incomplete verify checkpoint for ${input.task.taskId} (${prefix})`);
  }
  const bundleRef = await store.put(`${prefix}/harbor-task.tar.gz`, bundle, "application/gzip");
  return { report, reportRef, task: { ...input.task, taskId: report.taskId, bundle: bundleRef } };
}

function parseDefinition(bytes: Uint8Array, errors: string[]): TaskDefinition | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    errors.push(`definition.json is not valid JSON: ${message(error)}`);
    return undefined;
  }
  const parsed = taskDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(`definition ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    return undefined;
  }
  return parsed.data;
}

function checkCandidateIdentity(
  definition: TaskDefinition,
  candidate: CompileAndVerifyInput["candidate"],
  errors: string[],
): void {
  const mismatches = [
    ["sourcePr", definition.sourcePr, candidate.sourcePr],
    ["sourceUrl", definition.sourceUrl, candidate.sourceUrl],
    ["baseCommit", definition.baseCommit.toLowerCase(), candidate.baseCommit.toLowerCase()],
  ].filter(([, actual, expected]) => actual !== expected);
  const tier: Record<import("../../contracts.js").Difficulty, number> = {
    easy: 1,
    medium: 2,
    hard: 3,
  };
  if (tier[definition.difficulty] > tier[candidate.difficulty]) {
    mismatches.push(["difficulty", definition.difficulty, candidate.difficulty]);
  }
  for (const [field, actual, expected] of mismatches) {
    errors.push(
      `definition ${String(field)} is ${JSON.stringify(actual)} but the assigned candidate requires ${JSON.stringify(expected)}`,
    );
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
