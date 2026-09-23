import { Context } from "@temporalio/activity";
import { z } from "zod";
import type { ArtifactStore } from "../../artifacts/index.js";
import {
  type ArtifactRef,
  type AuthoredTask,
  type Candidate,
  type ReviewRoundResult,
  type RunRequest,
  taskDefinitionSchema,
  verifyReportSchema,
} from "../../contracts/index.js";
import type { SandboxExecutor, SandboxFile } from "../../sandbox/index.js";
import { runAgent } from "./agent.js";
import { readAsset } from "./helpers.js";
import { renderPrompt } from "./prompts.js";
import { renderVerifyReport } from "./verify-report.js";

export interface ReviewRoundInput {
  readonly run: RunRequest;
  readonly candidate: Candidate;
  readonly task: AuthoredTask;
  readonly report: ArtifactRef;
  readonly round: number;
}

const VERDICT = "/work/verdict/verdict.json";
const verdictSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("accepted"), reason: z.string().min(1) }),
  z.object({
    kind: z.literal("suggestions"),
    summary: z.string().min(1),
    suggestions: z.string().min(1),
  }),
  z.object({ kind: z.literal("rejected"), reason: z.string().min(1) }),
]);

/** A fresh, read-only reviewer judges one green task: accept, suggest changes, or reject. */
export async function runReviewRound(
  store: ArtifactStore,
  sandbox: SandboxExecutor,
  input: ReviewRoundInput,
): Promise<ReviewRoundResult> {
  const { run, candidate, task, round } = input;
  const roundPrefix = `runs/${run.runId}/review/${candidate.candidateId}/round-${round}`;
  const attempt = Context.current().info.attempt;
  const [reportBytes, definitionBytes, extension, program, bundle] = await Promise.all([
    store.get(input.report),
    store.get(task.definition),
    readAsset("dist/extension-reviewer.bundle.js"),
    readAsset("dist/sandbox-verifier.bundle.js"),
    bundleFile(store, task.bundle),
  ]);
  const report = verifyReportSchema.parse(JSON.parse(Buffer.from(reportBytes).toString("utf8")));
  if (!report.green) throw new Error("review requires a green report");
  const definition = taskDefinitionSchema.parse(
    JSON.parse(Buffer.from(definitionBytes).toString("utf8")),
  );
  const result = await runAgent({
    store,
    sandbox,
    run,
    label: `verify-${candidate.candidateId}-r${round}`,
    prefix: `${roundPrefix}/attempt-${attempt}`,
    sessionKey: `runs/${run.runId}/review/${candidate.candidateId}/session/round-${round}${attempt > 1 ? `-attempt-${attempt}` : ""}.jsonl`,
    workspace: { kind: "task" },
    extension: "/work/reviewer.js",
    tools: "read,grep,find,ls,accept_task,submit_suggestions,reject_task",
    prompt: renderPrompt("review", {
      taskId: task.taskId,
      instruction: definition.prompt.trim(),
      report: renderVerifyReport(report).trim(),
    }),
    files: [
      bundle,
      { path: "/work/sandbox-verifier.js", contents: program },
      { path: "/work/reviewer.js", contents: extension },
    ],
    outputs: [VERDICT],
    environment: { SELFBENCH_VERDICT_OUTPUT: "/work/verdict" },
    timeoutMs: 4 * 60 * 60 * 1000,
  });
  const verdictBytes = result.outputs[VERDICT];
  let outcome: ReviewRoundResult;
  if (verdictBytes && result.session) {
    const verdict = verdictSchema.parse(JSON.parse(Buffer.from(verdictBytes).toString("utf8")));
    await store.put(`${roundPrefix}/verdict.json`, verdictBytes, "application/json");
    outcome =
      verdict.kind === "rejected"
        ? {
            kind: "rejected",
            candidateId: candidate.candidateId,
            reason: `${verdict.reason}; log: ${result.log.uri}`,
          }
        : { ...verdict, session: result.session };
  } else if (result.exitCode !== 0 || result.providerError || !result.session) {
    throw new Error(
      `review round ${round} ended without a verdict (exit ${result.exitCode}); log: ${result.log.uri}`,
    );
  } else {
    outcome = {
      kind: "rejected",
      candidateId: candidate.candidateId,
      reason: `review agent declined the task${result.finalMessage ? `: ${result.finalMessage.slice(0, 1_000)}` : ""}; log: ${result.log.uri}`,
    };
  }
  await store.put(
    `${roundPrefix}/result.json`,
    Buffer.from(`${JSON.stringify(outcome, null, 2)}\n`),
    "application/json",
  );
  return outcome;
}

/** The compiled bundle can be hundreds of MB: let the sandbox pull it from a signed URL when possible. */
async function bundleFile(store: ArtifactStore, bundle: ArtifactRef): Promise<SandboxFile> {
  const url = await store.signedReadUrl?.(bundle, 2 * 60 * 60_000).catch(() => undefined);
  if (url) return { path: "/work/task.tar.gz", url, sha256: bundle.sha256 };
  return { path: "/work/task.tar.gz", contents: await store.get(bundle) };
}
