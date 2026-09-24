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
import type { SandboxExecutor } from "../../sandbox/index.js";
import type { SandboxJobOutcome } from "../../sandbox/jobs.js";
import { githubToken } from "../../third_party/github/token.js";
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
 * Harbor's half of the check: it builds the compiled task and runs smoke, nop, and oracle.
 * Every result lands in one report for the agent.
 */
export async function verifyCompiled(
  store: ArtifactStore,
  harborEnvironment: SelfBenchConfig["harborEnvironment"],
  input: VerifyCompiledInput,
): Promise<VerifyOutcome> {
  const { stage, round, compiled } = input;
  const prefix = verifyPrefix(input);
  return await withHeartbeats(`verifying ${input.task.taskId}`, async (signal) => {
    // The compile job only reports done with its result; anything else was retried in its sandbox.
    const result = compileResultSchema.parse(compiled.inline["result.json"]);

    const bundle = compiled.files["harbor-task.tar.gz"];
    const task: AuthoredTask | undefined =
      result.compileErrors.length === 0 && bundle ? { ...input.task, bundle } : undefined;
    const gates =
      task && result.auditBlockers.length === 0
        ? await runHarborGates(store, task, harborEnvironment, prefix, signal)
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
    return { report, reportRef, ...(task ? { task } : {}) };
  });
}
