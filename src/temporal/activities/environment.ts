import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CancelledFailure, Context } from "@temporalio/activity";
import type { ArtifactStore } from "../../artifacts.js";
import type { SelfBenchConfig } from "../../config.js";
import {
  type AuthorOutcome,
  type EnvironmentPreflightResult,
  taskDefinitionSchema,
  taskDraftDefinitionSchema,
} from "../../contracts.js";
import {
  assertEnvironmentOnlyRepair,
  assertEnvironmentPolicy,
  environmentAuthoringPrompt,
  isRepairableEnvironmentFailure,
} from "../../environment.js";
import type { HarborJobResult } from "../../harbor-results.js";
import type { SandboxExecutor } from "../../sandbox/index.js";
import { githubToken, loadPiModelAuth } from "../../subscription-auth.js";
import { environmentPreflightScript, environmentScript } from "./agent-scripts.js";
import { AGENT_INACTIVITY_TIMEOUT_MS, AUTHORING_TIMEOUT_MS } from "./constants.js";
import {
  compileEnvironmentTask,
  EnvironmentCompilerInfrastructureError,
} from "./environment-compiler.js";
import {
  boundedTail,
  exception,
  numberValue,
  rewards,
  runHarborGate,
  verifierOutput,
} from "./harbor.js";
import {
  readAsset,
  runSandboxWithFailureLog,
  withActivityHeartbeats,
  withTaskBundle,
} from "./runtime.js";
import type { EnvironmentAuthoringInput, TaskStageInput } from "./types.js";

export async function authorEnvironment(
  store: ArtifactStore,
  sandbox: SandboxExecutor,
  input: EnvironmentAuthoringInput,
): Promise<AuthorOutcome> {
  const revision = input.previousTask?.definition.sha256.slice(0, 12) ?? "initial";
  const checkpointPrefix = `runs/${input.run.runId}/environments/${input.task.taskId}/${input.task.sourceBundle.sha256.slice(0, 12)}/${revision}/trusted-compiler-v1`;
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
            { path: "/work/draft-definition.json", contents: draftBytes },
            { path: "/work/prompt.txt", contents: prompt },
          ],
          outputPaths: ["/work/definition.json"],
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
  const definitionBytes = result.outputs["/work/definition.json"];
  if (result.exitCode !== 0 || !definitionBytes) {
    return {
      kind: "rejected",
      candidateId: input.task.candidateId,
      reason: `environment authoring failed in ${result.sandboxId}; log: ${logs.uri}`,
    };
  }
  await validateEnvironmentDefinition(store, input, definitionBytes);
  let bundle: Uint8Array;
  try {
    bundle = await withActivityHeartbeats(
      `compiling environment for ${input.task.taskId}`,
      ({ signal }) =>
        compileEnvironmentTask({
          taskId: input.task.taskId,
          repositoryUrl: input.run.repository.url,
          definitionBytes,
          sourceBundle,
          ...(ghToken ? { token: ghToken } : {}),
          signal,
        }),
    );
  } catch (error) {
    if (
      error instanceof CancelledFailure ||
      error instanceof EnvironmentCompilerInfrastructureError
    ) {
      throw error;
    }
    return {
      kind: "rejected",
      candidateId: input.task.candidateId,
      reason: `environment compilation failed: ${boundedTail(errorMessage(error))}; log: ${logs.uri}`,
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
  const definition = await validateEnvironmentDefinition(store, input, definitionBytes);
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
async function validateEnvironmentDefinition(
  store: ArtifactStore,
  input: EnvironmentAuthoringInput,
  definitionBytes: Uint8Array,
) {
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
  return definition;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function preflightEnvironment(
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
      if (error instanceof CancelledFailure) {
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
