import { z } from "zod";
import type { ArtifactStore } from "../../artifacts.js";
import {
  type AuthoredTaskDraft,
  taskDefinitionSchema,
  type VerifierRoundResult,
} from "../../contracts.js";
import { PI_SESSION_OUTPUT_PATH } from "../../pi-session.js";
import { assertVerifierFix } from "../../verifier-fix.js";
import { materializeDraft, type OriginalTask } from "./drafts.js";
import {
  archiveSandboxResult,
  classifyRound,
  piExitCodeFrom,
  SandboxOutputError,
  type SandboxRoundResult,
} from "./round-outcome.js";
import type { StoredPiSession } from "./runtime.js";
import type { SessionVerifier } from "./session-verify.js";
import type { VerifierRoundInput } from "./types.js";

export const FIX_DEFINITION_PATH = "/work/fix/fixed-definition.json";
export const FIX_TEST_PATCH_PATH = "/work/fix/fixed-test.patch";
export const VERDICT_PATH = "/work/verdict/verdict.json";

const verdictSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("accepted"), reason: z.string().min(1) }).passthrough(),
  z.object({ kind: z.literal("fixed"), summary: z.string().min(1) }).passthrough(),
  z.object({ kind: z.literal("none") }),
]);

export interface VerifierOutcomeInput {
  readonly store: ArtifactStore;
  readonly input: VerifierRoundInput;
  readonly prefix: string;
  /** `<prefix>/attempt-<n>`: where this attempt's pre-decision artifacts go. */
  readonly attemptPrefix: string;
  readonly result: SandboxRoundResult;
  readonly session: StoredPiSession | undefined;
  readonly logUri: string;
  readonly original: OriginalTask;
  readonly verifier: SessionVerifier;
}

/** Turns the sandbox's verdict and fix files into the round result, validating fix boundaries. */
export async function resolveVerifierOutcome(
  input: VerifierOutcomeInput,
): Promise<VerifierRoundResult> {
  const { store, prefix, attemptPrefix, result, session, logUri, original, verifier } = input;
  const { candidate, round } = input.input;
  const reject = (reason: string): VerifierRoundResult => ({
    kind: "rejected",
    candidateId: candidate.candidateId,
    reason: `${reason}; log: ${logUri}`,
  });
  const verdictBytes = result.outputs[VERDICT_PATH];
  const missing = await archiveSandboxResult(
    store,
    `${attemptPrefix}/sandbox-result.json`,
    result,
    [VERDICT_PATH, FIX_DEFINITION_PATH, FIX_TEST_PATCH_PATH, PI_SESSION_OUTPUT_PATH],
  );
  const classified = classifyRound({
    round,
    exitCode: result.exitCode,
    piExitCode: piExitCodeFrom(result.stdout),
    missing: missing.filter((path) => path !== PI_SESSION_OUTPUT_PATH),
    sessionCollected: session !== undefined,
    toolCalls: session?.toolCalls ?? [],
    finalMessage: session?.finalMessage,
  });
  if (classified.kind === "infrastructure") {
    throw new SandboxOutputError(`verifier ${classified.reason}; log: ${logUri}`);
  }
  if (classified.kind === "rejected" || !verdictBytes || !session) {
    return reject(
      `verifier ${classified.kind === "rejected" ? classified.reason : `round ${round} delivered no verdict`}`,
    );
  }
  const verdict = verdictSchema.safeParse(JSON.parse(Buffer.from(verdictBytes).toString("utf8")));
  if (!verdict.success) {
    return reject(`verifier round ${round} produced an unreadable verdict`);
  }
  await store.put(`${prefix}/verdict.json`, verdictBytes, "application/json");
  if (verdict.data.kind === "none") {
    return reject(`verification agent declined the task${explanation(session)}`);
  }
  if (verdict.data.kind === "accepted") {
    return { kind: "accepted", session: session.ref, reason: verdict.data.reason };
  }
  const fixedDefinitionBytes = result.outputs[FIX_DEFINITION_PATH];
  const fixedTestPatchBytes = result.outputs[FIX_TEST_PATCH_PATH];
  if (!fixedDefinitionBytes || !fixedTestPatchBytes) {
    return reject(`verifier round ${round} recorded a fix without its files`);
  }
  const fixedDefinitionJson = Buffer.from(fixedDefinitionBytes).toString("utf8");
  const fixedTestPatch = Buffer.from(fixedTestPatchBytes).toString("utf8");
  let fixedTask: AuthoredTaskDraft;
  try {
    const fixed = taskDefinitionSchema.parse(JSON.parse(fixedDefinitionJson));
    assertVerifierFix({
      original: original.definition,
      fixed,
      originalTestPatch: original.testPatch,
      fixedTestPatch,
      originalGoldPatch: original.goldPatch,
      fixedGoldPatch: original.goldPatch,
    });
    fixedTask = await materializeDraft(
      store,
      `${prefix}/fix`,
      candidate.candidateId,
      JSON.stringify(fixed, null, 2),
      fixedTestPatch,
      original.goldPatch,
    );
  } catch (error) {
    return reject(
      `verifier fix rejected: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const verified = verifier.verified(
    JSON.parse(fixedDefinitionJson),
    fixedTestPatch,
    original.goldPatch,
  );
  return {
    kind: "fixed",
    task: fixedTask,
    session: session.ref,
    summary: verdict.data.summary,
    verifyCalls: verifier.records.length,
    ...(verified ? { verified } : {}),
  };
}

function explanation(session: StoredPiSession | undefined): string {
  return session?.finalMessage ? `: ${session.finalMessage.slice(0, 1_000)}` : "";
}
