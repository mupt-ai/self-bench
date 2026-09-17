import { CancelledFailure, Context } from "@temporalio/activity";
import type { ArtifactStore } from "../../artifacts.js";
import type { SelfBenchConfig } from "../../config.js";
import type {
  ArtifactRef,
  AuthoredTask,
  Candidate,
  RunRequest,
  VerifyStage,
} from "../../contracts.js";
import type { LiveSandbox } from "../../sandbox/index.js";
import {
  type MailboxRequest,
  type MailboxResponse,
  superviseMailbox,
} from "../../sandbox/supervisor.js";
import { matchingGreenVerify, submissionHash } from "../../submission-hash.js";
import { renderVerifyReport, verifyReportSummary } from "../../verify-report.js";
import { materializeDraft } from "./drafts.js";
import { activityLifetimeSignal } from "./runtime.js";
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
    const signal = activityLifetimeSignal(exited);
    // The mailbox has awaits between handler completion and response publication.
    const activeSandbox: LiveSandbox = {
      sandboxId: sandbox.sandboxId,
      execute: (command) => {
        signal.throwIfAborted();
        return sandbox.execute(command);
      },
      readFile: (path) => {
        signal.throwIfAborted();
        return sandbox.readFile(path);
      },
      writeFile: (path, contents) => {
        signal.throwIfAborted();
        return sandbox.writeFile(path, contents);
      },
    };
    return superviseMailbox(activeSandbox, signal, {
      handle: (request) => this.handle(request, signal),
      isFatal: (error) => signal.aborted || error instanceof CancelledFailure,
      onPoll: () => Context.current().heartbeat(`mailbox ${this.records.length} verifies`),
    }).then(() => {
      if (Context.current().cancellationSignal.aborted) {
        throw new CancelledFailure("activity cancellation requested");
      }
    });
  }

  async handle(request: MailboxRequest, lifetime?: AbortSignal): Promise<MailboxResponse> {
    const signal = activityLifetimeSignal(lifetime);
    signal.throwIfAborted();
    const { store, run, candidate, stage, round } = this.#context;
    const index = this.records.length + 1;
    const prefix = `${this.#context.prefix}/verify-${index}`;
    const goldPatch = request.goldPatch;
    if (goldPatch === undefined) {
      return { id: request.id, kind: "error", message: "verify request has no gold patch" };
    }
    const definitionJson = `${JSON.stringify(request.definition, null, 2)}\n`;
    await store.put(
      `${prefix}/request.json`,
      Buffer.from(`${JSON.stringify(request)}\n`),
      "application/json",
    );
    signal.throwIfAborted();
    const draft = await materializeDraft(
      store,
      prefix,
      candidate.candidateId,
      definitionJson,
      request.testPatch,
      goldPatch,
    );
    signal.throwIfAborted();
    const outcome = await compileAndVerify(
      store,
      this.#context.harborEnvironment,
      { run, candidate, task: draft, stage, round },
      prefix,
      signal,
    );
    signal.throwIfAborted();
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
