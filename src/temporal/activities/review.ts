import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Context } from "@temporalio/activity";
import type { ArtifactStore } from "../../artifacts.js";
import { auditTaskDefinition } from "../../audit.js";
import {
  COUPLING_REVIEW_MODEL,
  couplingReviewInput,
  couplingReviewSchema,
} from "../../codex-review.js";
import {
  type AuditResult,
  type AuthorOutcome,
  type ReviewResult,
  taskDefinitionSchema,
} from "../../contracts.js";
import {
  buildCouplingEvidence,
  discoverContractArtifacts,
  resolveCouplingReview,
  scanBaseContractArtifacts,
} from "../../coupling.js";
import { refreshHarborTask } from "../../harbor-task.js";
import { runCommand } from "../../process.js";
import { assertRepairedPatchPaths } from "../../repair.js";
import type { SandboxExecutor } from "../../sandbox/index.js";
import { loadPiModelAuth } from "../../subscription-auth.js";
import { AGENT_INACTIVITY_TIMEOUT_MS, REVIEW_INACTIVITY_TIMEOUT_MS } from "./constants.js";
import { readAsset, withActivityHeartbeats, withTaskBundle } from "./runtime.js";
import type { RepairTaskInput, TaskStageInput } from "./types.js";

export async function reviewTask(
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
export async function repairTask(
  store: ArtifactStore,
  sandbox: SandboxExecutor,
  input: RepairTaskInput,
): Promise<AuthorOutcome> {
  Context.current().heartbeat(`repairing held-out tests for ${input.task.taskId}`);
  const checkpointPrefix = `runs/${input.run.runId}/repairs/${input.task.taskId}/trusted-rebuild-v1`;
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
    loadPiModelAuth(),
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
          outputPaths: ["/work/repaired-test.patch", "/work/repair-report.json"],
          secrets: {
            ...(authJson.apiKey ? { OPENAI_API_KEY: authJson.apiKey } : {}),
            ...(authJson.authJson ? { SELFBENCH_PI_AUTH_JSON: authJson.authJson } : {}),
          },
          environment: { SELFBENCH_REPAIR_MODEL: input.run.authoring.model },
          command: [
            "node",
            "/work/sandbox-repair.js",
            "/work/task.tar.gz",
            "/work/review.json",
            "/work/repaired-test.patch",
            "/work/repair-report.json",
          ],
        },
        options,
      ),
  );
  const repairedPatch = result.outputs["/work/repaired-test.patch"];
  const repairReport = result.outputs["/work/repair-report.json"];
  const logs = await store.put(
    `${attemptPrefix}/sandbox.log`,
    Buffer.from(`${result.stdout}\n${result.stderr}`),
    "text/plain",
  );
  if (result.exitCode !== 0 || !repairedPatch || !repairReport) {
    return {
      kind: "rejected",
      candidateId: input.task.candidateId,
      reason: `test repair failed in ${result.sandboxId}; log: ${logs.uri}`,
    };
  }
  const originalPatch = await withTaskBundle(store, input.task, async (taskDirectory) =>
    readFile(join(taskDirectory, "tests/test.patch"), "utf8"),
  );
  const repairedPatchText = Buffer.from(repairedPatch).toString("utf8");
  assertRepairedPatchPaths(originalPatch, repairedPatchText);
  const repairedBundle = await withTaskBundle(store, input.task, async (taskDirectory, root) => {
    await writeFile(join(taskDirectory, "tests/test.patch"), repairedPatch);
    const definition = taskDefinitionSchema.parse(
      JSON.parse(Buffer.from(await store.get(input.task.definition)).toString("utf8")),
    );
    await refreshHarborTask(taskDirectory, definition);
    const archive = join(root, "repaired-task.tar.gz");
    await runCommand("tar", ["-czf", archive, "-C", root, "harbor-task"]);
    return await readFile(archive);
  });
  await store.put(`${attemptPrefix}/report.json`, repairReport, "application/json");
  const repairedRef = await store.put(
    `${checkpointPrefix}/harbor-task.tar.gz`,
    repairedBundle,
    "application/gzip",
  );
  return { kind: "authored", task: { ...input.task, bundle: repairedRef } };
}
export async function auditTask(store: ArtifactStore, input: TaskStageInput): Promise<AuditResult> {
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
