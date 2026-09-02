import { CancelledFailure, Context } from "@temporalio/activity";
import type { ArtifactStore } from "../../artifacts.js";
import type { SelfBenchConfig } from "../../config.js";
import {
  type ArtifactRef,
  type AuthoredTask,
  type Candidate,
  type RunRequest,
  taskDefinitionSchema,
  type VerifyStage,
} from "../../contracts.js";
import type { LiveSandbox } from "../../sandbox/index.js";
import {
  type MailboxRequest,
  type MailboxResponse,
  superviseMailbox,
} from "../../sandbox/supervisor.js";
import { matchingGreenVerify, submissionHash } from "../../submission-hash.js";
import { assertVerifierFix } from "../../verifier-fix.js";
import { renderVerifyReport, verifyReportSummary } from "../../verify-report.js";
import { materializeDraft, type OriginalTask } from "./drafts.js";
import { compileAndVerify } from "./verify.js";

export interface SessionVerifyContext {
  readonly store: ArtifactStore;
  readonly harborEnvironment: SelfBenchConfig["harborEnvironment"];
  readonly run: RunRequest;
  readonly candidate: Candidate;
  readonly stage: VerifyStage;
  readonly round: number;
  /** Round artifact prefix; verifies are stored under `<prefix>/verify-<k>/`. */
  readonly prefix: string;
  /** For verifier sessions: the task a fix must stay within. */
  readonly original?: OriginalTask;
}

export interface SessionVerifyRecord {
  readonly index: number;
  readonly hash: string;
  readonly green: boolean;
  readonly report: ArtifactRef;
  readonly task?: AuthoredTask;
}

export interface VerifiedSubmission {
  readonly report: ArtifactRef;
  readonly task: AuthoredTask;
}

/**
 * Worker side of the agent's `verify` tool: each mailbox request becomes a draft, goes through the
 * same compile/audit/build/smoke/nop/oracle as a submission, and is archived per call. A later
 * submission with the same payload hash reuses the green result.
 */
export class SessionVerifier {
  readonly records: SessionVerifyRecord[] = [];
  readonly #context: SessionVerifyContext;

  constructor(context: SessionVerifyContext) {
    this.#context = context;
  }

  /** Supervises the live sandbox mailbox for the duration of the agent command. */
  supervise(sandbox: LiveSandbox, exited: AbortSignal): Promise<void> {
    return superviseMailbox(sandbox, exited, {
      handle: (request) => this.handle(request),
      isFatal: (error) => error instanceof CancelledFailure,
      onPoll: () => Context.current().heartbeat(`mailbox ${this.records.length} verifies`),
    }).then(() => undefined);
  }

  async handle(request: MailboxRequest): Promise<MailboxResponse> {
    const { store, run, candidate, stage, round } = this.#context;
    const index = this.records.length + 1;
    const prefix = `${this.#context.prefix}/verify-${index}`;
    const goldPatch = this.#context.original?.goldPatch ?? request.goldPatch;
    if (goldPatch === undefined) {
      return { id: request.id, kind: "error", message: "verify request has no gold patch" };
    }
    const definitionJson = `${JSON.stringify(request.definition, null, 2)}\n`;
    if (this.#context.original) {
      const boundary = fixBoundaryError(this.#context.original, request, goldPatch);
      if (boundary) {
        return { id: request.id, kind: "error", message: boundary };
      }
    }
    await store.put(
      `${prefix}/request.json`,
      Buffer.from(`${JSON.stringify(request)}\n`),
      "application/json",
    );
    const draft = await materializeDraft(
      store,
      prefix,
      candidate.candidateId,
      definitionJson,
      request.testPatch,
      goldPatch,
    );
    const outcome = await compileAndVerify(
      store,
      this.#context.harborEnvironment,
      { run, candidate, task: draft, stage, round },
      prefix,
    );
    this.records.push({
      index,
      hash: submissionHash({
        definition: request.definition,
        testPatch: request.testPatch,
        goldPatch,
      }),
      green: outcome.report.green,
      report: outcome.reportRef,
      ...(outcome.task ? { task: outcome.task } : {}),
    });
    return {
      id: request.id,
      kind: "report",
      green: outcome.report.green,
      summary: verifyReportSummary(outcome.report),
      rendered: renderVerifyReport(outcome.report),
    };
  }

  /** The green verify matching a submission, if the agent submitted exactly what it verified. */
  verified(
    definition: unknown,
    testPatch: string,
    goldPatch: string,
  ): VerifiedSubmission | undefined {
    const match = matchingGreenVerify(
      submissionHash({ definition, testPatch, goldPatch }),
      this.records,
    );
    return match?.task ? { report: match.report, task: match.task } : undefined;
  }
}

function fixBoundaryError(
  original: OriginalTask,
  request: MailboxRequest,
  goldPatch: string,
): string | undefined {
  const parsed = taskDefinitionSchema.safeParse(request.definition);
  if (!parsed.success) {
    return `fixed definition is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`;
  }
  try {
    assertVerifierFix({
      original: original.definition,
      fixed: parsed.data,
      originalTestPatch: original.testPatch,
      fixedTestPatch: request.testPatch,
      originalGoldPatch: original.goldPatch,
      fixedGoldPatch: goldPatch,
    });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
