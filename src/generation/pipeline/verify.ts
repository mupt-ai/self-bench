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
  /** Set when the compiler could not run (e.g. the repository could not be cloned). */
  infrastructure: z.string().optional(),
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
      result: "/work/result.json",
      prefix: `${verifyPrefix(input)}/compile`,
    },
    callback,
  );
}

/**
 * Harbor's half of the check: it stops the compile sandbox, builds the compiled task, and runs
 * smoke, nop, and oracle. Every result lands in one report for the agent.
 */
export async function verifyCompiled(
  store: ArtifactStore,
  sandbox: SandboxExecutor,
  harborEnvironment: SelfBenchConfig["harborEnvironment"],
  input: VerifyCompiledInput,
): Promise<VerifyOutcome> {
  const { stage, round, compiled } = input;
  const prefix = verifyPrefix(input);
  await sandbox.stop(compiled.sandbox).catch(() => undefined);
  return await withHeartbeats(`verifying ${input.task.taskId}`, async (options) => {
    if (compiled.exitCode !== 0 || compiled.result === undefined) {
      throw new Error(
        `compiler sandbox exited ${compiled.exitCode}; log: ${compiled.files["job.log"]?.uri ?? "none"}`,
      );
    }
    const result = compileResultSchema.parse(compiled.result);
    if (result.infrastructure) throw new Error(`compiler could not run: ${result.infrastructure}`);

    const bundle = compiled.files["harbor-task.tar.gz"];
    const task: AuthoredTask | undefined =
      result.compileErrors.length === 0 && bundle ? { ...input.task, bundle } : undefined;
    const gates =
      task && result.auditBlockers.length === 0
        ? await runHarborGates(store, task, harborEnvironment, prefix, options.signal)
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
