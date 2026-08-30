import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Context } from "@temporalio/activity";
import type { ArtifactStore } from "../../artifacts.js";
import type { SelfBenchConfig } from "../../config.js";
import {
  type AuthorOutcome,
  taskDefinitionSchema,
  type ValidationResult,
} from "../../contracts.js";
import { refreshHarborTask } from "../../harbor-task.js";
import { runCommand } from "../../process.js";
import type { SandboxExecutor } from "../../sandbox/index.js";
import { loadPiModelAuth } from "../../subscription-auth.js";
import { assertValidationRepairPatch } from "../../validation-repair.js";
import { AGENT_INACTIVITY_TIMEOUT_MS } from "./constants.js";
import {
  exception,
  harborGateFailureReason,
  numberValue,
  rewards,
  runHarborGate,
  verifierOutput,
} from "./harbor.js";
import { readAsset, withActivityHeartbeats, withTaskBundle } from "./runtime.js";
import type { TaskStageInput, ValidationRepairTaskInput } from "./types.js";

export async function validateTask(
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
export async function repairValidationTask(
  store: ArtifactStore,
  sandbox: SandboxExecutor,
  input: ValidationRepairTaskInput,
): Promise<AuthorOutcome> {
  Context.current().heartbeat(`repairing validation harness for ${input.task.taskId}`);
  const checkpointPrefix = `runs/${input.run.runId}/validation-repairs/${input.task.taskId}/${input.task.bundle.sha256.slice(0, 12)}/trusted-rebuild-v1`;
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
  ]);
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
  const originalDefinition = taskDefinitionSchema.parse(
    JSON.parse(Buffer.from(definition).toString("utf8")),
  );
  const parsedDefinition = taskDefinitionSchema.parse(
    JSON.parse(Buffer.from(repairedDefinition).toString("utf8")),
  );
  const originalTestPatch = await withTaskBundle(store, input.task, async (taskDirectory) =>
    readFile(join(taskDirectory, "tests/test.patch"), "utf8"),
  );
  assertValidationRepairPatch(
    originalDefinition,
    parsedDefinition,
    originalTestPatch,
    Buffer.from(repairedTestPatch).toString("utf8"),
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
