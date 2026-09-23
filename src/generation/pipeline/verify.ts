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
import { githubToken } from "../../third_party/github/token.js";
import { verifierRuntimeFiles } from "../task/runtime-assets.js";
import { notRunGates, runHarborGates } from "./harbor-gates.js";
import { readAsset, withHeartbeats } from "./helpers.js";
import { isGreen, renderVerifyReport } from "./verify-report.js";

export interface CompileAndVerifyInput {
  readonly run: RunRequest;
  readonly candidate: Candidate;
  readonly task: AuthoredTaskDraft;
  readonly stage: PipelineStage;
  readonly round: number;
}

const compileResultSchema = z.object({
  compileErrors: z.array(z.string()),
  auditBlockers: z.array(z.string()),
  /** Set when the compiler could not run (e.g. the repository could not be cloned). */
  infrastructure: z.string().optional(),
});

/**
 * The full check of one submission. The compiler sandbox validates the definition, patches,
 * environment policy, audit, and candidate identity, then renders the Harbor task; Harbor then
 * builds it and runs smoke, nop, and oracle, unless the run chose static verification. Every
 * result lands in one report for the agent.
 */
export async function compileAndVerify(
  store: ArtifactStore,
  sandbox: SandboxExecutor,
  harborEnvironment: SelfBenchConfig["harborEnvironment"],
  input: CompileAndVerifyInput,
  prefix = `runs/${input.run.runId}/verify/${input.candidate.candidateId}/${input.stage}-round-${input.round}`,
): Promise<VerifyOutcome> {
  const { run, candidate, stage, round } = input;
  return await withHeartbeats(`verifying ${input.task.taskId}`, async (options) => {
    const [program, sourceBundle, token] = await Promise.all([
      readAsset("dist/sandbox-compiler.bundle.js"),
      store.get(input.task.sourceBundle),
      githubToken(),
    ]);
    const compiled = await sandbox.run(
      {
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
          { path: "/work/source-task.tar.gz", contents: sourceBundle },
        ],
        secrets: token ? { GH_TOKEN: token } : {},
        outputPaths: ["/work/result.json", "/work/compiled.tar.gz"],
      },
      options,
    );
    const resultBytes = compiled.outputs["/work/result.json"];
    if (compiled.exitCode !== 0 || !resultBytes) {
      throw new Error(
        `compiler sandbox exited ${compiled.exitCode}: ${compiled.stderr.slice(-2_000)}`,
      );
    }
    const result = compileResultSchema.parse(JSON.parse(Buffer.from(resultBytes).toString("utf8")));
    if (result.infrastructure) throw new Error(`compiler could not run: ${result.infrastructure}`);

    let task: AuthoredTask | undefined;
    const bundle = compiled.outputs["/work/compiled.tar.gz"];
    if (result.compileErrors.length === 0 && bundle?.length) {
      const bundleRef = await store.put(`${prefix}/harbor-task.tar.gz`, bundle, "application/gzip");
      task = { ...input.task, bundle: bundleRef };
    }
    const staticOnly = run.generation?.settings.verification === "static";
    const gates =
      task && result.auditBlockers.length === 0 && !staticOnly
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
      ...(staticOnly ? { staticOnly } : {}),
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
