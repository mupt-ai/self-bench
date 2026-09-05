import { z } from "zod";
import type { ArtifactStore } from "../../artifacts.js";
import type { VerifierRoundResult } from "../../contracts.js";
import { PI_SESSION_OUTPUT_PATH } from "../../pi-session.js";
import {
  archiveSandboxResult,
  classifyRound,
  piExitCodeFrom,
  SandboxOutputError,
  type SandboxRoundResult,
} from "./round-outcome.js";
import type { StoredPiSession } from "./runtime.js";
import type { VerifierRoundInput } from "./types.js";

export const VERDICT_PATH = "/work/verdict/verdict.json";

const verdictSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("accepted"), reason: z.string().min(1) }).passthrough(),
  z
    .object({
      kind: z.literal("suggestions"),
      summary: z.string().min(1),
      suggestions: z.string().min(1),
    })
    .passthrough(),
  z.object({ kind: z.literal("rejected"), reason: z.string().min(1) }),
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
}

/** Archives a read-only verdict; never imports task modifications from the reviewer. */
export async function resolveVerifierOutcome(
  input: VerifierOutcomeInput,
): Promise<VerifierRoundResult> {
  const { store, prefix, attemptPrefix, result, session, logUri } = input;
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
    [VERDICT_PATH, PI_SESSION_OUTPUT_PATH],
  );
  const classified = classifyRound({
    round,
    exitCode: result.exitCode,
    piExitCode: piExitCodeFrom(result.stdout),
    missing: missing.filter((path) => path !== PI_SESSION_OUTPUT_PATH),
    sessionCollected: session !== undefined,
    toolCalls: session?.toolCalls ?? [],
    finalMessage: session?.finalMessage,
    providerError: session?.providerError,
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
  if (verdict.data.kind === "rejected") return reject(verdict.data.reason);
  if (verdict.data.kind === "accepted") {
    return { kind: "accepted", session: session.ref, reason: verdict.data.reason };
  }
  if (verdict.data.kind === "suggestions") {
    return {
      kind: "suggestions",
      session: session.ref,
      summary: verdict.data.summary,
      suggestions: verdict.data.suggestions,
    };
  }
  return reject("unsupported verifier verdict");
}

function explanation(session: StoredPiSession | undefined): string {
  return session?.finalMessage ? `: ${session.finalMessage.slice(0, 1_000)}` : "";
}
