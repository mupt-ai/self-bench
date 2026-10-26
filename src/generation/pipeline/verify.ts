import { Context } from "@temporalio/activity";
import { z } from "zod";
import type { ArtifactStore } from "../../artifacts/index.js";
import type { SelfBenchConfig } from "../../contracts/config/index.js";
import type {
  AuthoredTask,
  AuthoredTaskDraft,
  Candidate,
  PipelineStage,
  RunRequest,
  VerifyOutcome,
  VerifyReport,
} from "../../contracts/index.js";
import { GATE_TASK_FILE, SNAPSHOT_FILE } from "../../sandbox/gate-bundle.js";
import type { SandboxExecutor } from "../../sandbox/index.js";
import type { SandboxJobOutcome } from "../../sandbox/jobs.js";
import { githubToken } from "../../third_party/github/token.js";
import type { TaskImageBuilder } from "../images/builder.js";
import { verifierRuntimeFiles } from "../task/runtime-assets.js";
import { notRunGates, runHarborGates } from "./harbor-gates.js";
import { artifactFile, readAsset, withHeartbeats } from "./helpers.js";
import { runSandboxJob, type SandboxCallback } from "./sandbox-job.js";
import { isGreen, renderVerifyReport } from "./verify-report.js";

export interface CompileAndVerifyInput {
  readonly run: RunRequest;
  readonly candidate: Candidate;
  readonly task: AuthoredTaskDraft;
  readonly stage: PipelineStage;
  readonly round: number;
  /** Set for a `verify` the author asked for mid-round: the turn that asked. */
  readonly turn?: number;
}

const compileResultSchema = z.object({
  compileErrors: z.array(z.string()),
  auditBlockers: z.array(z.string()),
});

export interface VerifyCompiledInput extends CompileAndVerifyInput {
  readonly compiled: SandboxJobOutcome;
}

const PINNED_DEFINITION = "definition.json";

/** Every artifact of one check lands under this folder. */
function verifyPrefix(input: CompileAndVerifyInput): string {
  return `runs/${input.run.runId}/verify/${input.candidate.candidateId}/${input.stage}-round-${input.round}${input.turn ? `-turn-${input.turn}` : ""}`;
}

/**
 * The trusted compile of one submission, in its own sandbox: it validates the definition,
 * patches, environment policy, audit, and candidate identity, then renders the Harbor task.
 */
export async function compileTask(
  store: ArtifactStore,
  sandbox: SandboxExecutor,
  input: CompileAndVerifyInput,
  callback: SandboxCallback,
): Promise<SandboxJobOutcome> {
  const { run, candidate } = input;
  const [program, token, source] = await Promise.all([
    readAsset("dist/sandbox-compiler.bundle.js"),
    githubToken(),
    artifactFile(store, input.task.sourceBundle, "/work/source-task.tar.gz"),
  ]);
  return await runSandboxJob(
    sandbox,
    {
      request: {
        runId: run.runId,
        stage: `compile-${candidate.candidateId}`,
        timeoutMs: 30 * 60_000,
        command: ["node", "/work/compiler.js"],
        files: [
          { path: "/work/compiler.js", contents: program },
          ...Object.entries(verifierRuntimeFiles()).map(([path, contents]) => ({
            path: `/work/${path}`,
            contents,
          })),
          {
            path: "/work/input.json",
            contents: JSON.stringify({
              repositoryUrl: run.repository.url,
              harborEnvironment: run.version.harborEnvironment,
              candidate: {
                sourcePr: candidate.sourcePr,
                sourceUrl: candidate.sourceUrl,
                baseCommit: candidate.baseCommit,
                difficulty: candidate.difficulty,
              },
            }),
          },
          source,
        ],
        secrets: token ? { GH_TOKEN: token } : {},
      },
      outputs: [
        {
          name: "harbor-task.tar.gz",
          path: "/work/compiled.tar.gz",
          contentType: "application/gzip",
        },
        {
          name: GATE_TASK_FILE,
          path: `/work/${GATE_TASK_FILE}`,
          contentType: "application/gzip",
        },
        { name: SNAPSHOT_FILE, path: `/work/${SNAPSHOT_FILE}`, contentType: "application/gzip" },
        {
          name: PINNED_DEFINITION,
          path: `/work/${PINNED_DEFINITION}`,
          contentType: "application/json",
        },
      ],
      inline: [{ name: "result.json", path: "/work/result.json" }],
      // A compiler that crashed or could not run reports no result, and Temporal reruns it.
      delivers: [["/work/result.json"]],
      requireDelivery: true,
      log: "compile.log",
      prefix: `${verifyPrefix(input)}/compile/attempt-${Context.current().info.attempt}`,
    },
    callback,
  );
}

/**
 * Stops the compile sandbox as soon as it reported, on the ordinary queue, so it never waits for
 * a Harbor slot while it is still billed.
 */
export async function finishCompile(
  sandbox: SandboxExecutor,
  input: VerifyCompiledInput,
): Promise<SandboxJobOutcome> {
  await sandbox.stop(input.compiled.sandbox).catch(() => undefined);
  return input.compiled;
}

/**
 * The check after the compile: the deployment's builder builds the task's images (the build gate),
 * and Harbor runs smoke, nop, and oracle on them on the run's provider. Every result lands in one
 * report for the agent; a green check's task carries the images its oracle passed on.
 */
export async function verifyCompiled(
  store: ArtifactStore,
  harborEnvironment: SelfBenchConfig["harborEnvironment"],
  input: VerifyCompiledInput,
  callback: SandboxCallback,
  builder?: TaskImageBuilder,
): Promise<VerifyOutcome> {
  const { stage, round, compiled } = input;
  const prefix = verifyPrefix(input);
  return await withHeartbeats(`verifying ${input.task.taskId}`, async (signal) => {
    // The compile job only reports done with its result; anything else was retried in its sandbox.
    const result = compileResultSchema.parse(compiled.inline["result.json"]);

    const bundle = compiled.files["harbor-task.tar.gz"];
    // The compiled definition carries the image digests the compiler pinned.
    const definition = compiled.files[PINNED_DEFINITION] ?? input.task.definition;
    const task: AuthoredTask | undefined =
      result.compileErrors.length === 0 && bundle
        ? { ...input.task, definition, bundle }
        : undefined;
    const gate = compiled.files[GATE_TASK_FILE];
    const snapshot = compiled.files[SNAPSHOT_FILE];
    if (builder && task && (!gate || !snapshot))
      throw new Error("The compile wrote no gate task or snapshot to build images from");
    const { images, ...gates }: Awaited<ReturnType<typeof runHarborGates>> =
      task && result.auditBlockers.length === 0
        ? await runHarborGates(
            store,
            task,
            harborEnvironment,
            prefix,
            signal,
            builder && gate && snapshot
              ? {
                  builder,
                  build: {
                    runId: input.run.runId,
                    candidateId: input.candidate.candidateId,
                    gate,
                    snapshot,
                    prefix: compiled.prefix,
                  },
                  serving: { env: process.env, callback },
                }
              : undefined,
          )
        : notRunGates();
    const partial = {
      schemaVersion: 1 as const,
      stage,
      round,
      taskId: input.task.taskId,
      compile: { ok: result.compileErrors.length === 0, errors: result.compileErrors },
      audit: { ok: result.auditBlockers.length === 0, blockers: result.auditBlockers },
      ...gates,
    };
    const report: VerifyReport = { ...partial, green: isGreen(partial) };
    await store.put(
      `${prefix}/report.md`,
      Buffer.from(renderVerifyReport(report)),
      "text/markdown",
    );
    const reportRef = await store.put(
      `${prefix}/report.json`,
      Buffer.from(`${JSON.stringify(report, null, 2)}\n`),
      "application/json",
    );
    return { report, reportRef, ...(task ? { task: images ? { ...task, images } : task } : {}) };
  });
}
