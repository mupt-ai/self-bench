import type { ArtifactStore } from "../../artifacts.js";
import { boundedTail } from "./harbor.js";

/** Tool calls that end an agent session with a deliverable the worker must be able to collect. */
export const TERMINAL_TOOLS = ["submit_task", "submit_fix", "accept_task"] as const;
const HARD_TIMEOUT_EXIT_CODE = 124;

export interface SandboxRoundResult {
  readonly sandboxId: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputs: Readonly<Record<string, Uint8Array>>;
}

/** A delivered submission or verdict could not be collected; retrying the activity is correct. */
export class SandboxOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxOutputError";
  }
}

export type RoundVerdict =
  | { readonly kind: "ok" }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "infrastructure"; readonly reason: string };

export interface RoundClassification {
  readonly round: number;
  readonly exitCode: number;
  /** pi's own exit code as printed by the wrapper, when it differs from the command's. */
  readonly piExitCode?: number | undefined;
  /** Declared outputs that were not collected. */
  readonly missing: readonly string[];
  readonly sessionCollected: boolean;
  readonly toolCalls: readonly string[];
  readonly finalMessage?: string | undefined;
}

/**
 * Why a round did not deliver, phrased so a human can act on it. A delivered terminal tool call
 * whose output is missing, and a sandbox that died before any terminal call, are infrastructure
 * problems for Temporal to retry, never candidate rejections.
 */
export function classifyRound(input: RoundClassification): RoundVerdict {
  const terminal = [...input.toolCalls]
    .reverse()
    .find((name) => TERMINAL_TOOLS.includes(name as never));
  const pi = input.piExitCode ?? input.exitCode;
  const explanation = input.finalMessage
    ? `; agent said: ${input.finalMessage.slice(0, 1_000)}`
    : "";
  if (input.exitCode === 0 && input.missing.length === 0 && input.sessionCollected) {
    return { kind: "ok" };
  }
  if (input.exitCode === 0) {
    const what =
      input.missing.length > 0
        ? `output ${input.missing.join(", ")} missing`
        : "session output missing";
    return {
      kind: "infrastructure",
      reason: `round ${input.round}: ${what} (pi exit 0${terminal ? ` after ${terminal}` : ""}); the sandbox delivered but collection failed`,
    };
  }
  if (terminal) {
    return {
      kind: "infrastructure",
      reason: `round ${input.round}: wrapper exited with code ${input.exitCode} after ${terminal} was recorded`,
    };
  }
  if (input.exitCode === HARD_TIMEOUT_EXIT_CODE || !input.sessionCollected) {
    return {
      kind: "infrastructure",
      reason: `round ${input.round}: sandbox died mid-round (exit ${input.exitCode}${input.sessionCollected ? "" : ", no session collected"}) before a terminal tool call`,
    };
  }
  if (pi !== 0) {
    return {
      kind: "rejected",
      reason: `round ${input.round}: pi exited with code ${pi}${explanation}`,
    };
  }
  return {
    kind: "rejected",
    reason: `round ${input.round}: pi exited 0 without a terminal tool call and the wrapper exited with code ${input.exitCode}${explanation}`,
  };
}

/** `[selfbench] pi exited with N` as printed by the round wrapper. */
export function piExitCodeFrom(stdout: string): number | undefined {
  const match = /\[selfbench\] pi exited with (\d+)/.exec(stdout);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/** Archives exit code, collected outputs with sizes, and output tails next to the round. */
export async function archiveSandboxResult(
  store: ArtifactStore,
  key: string,
  result: SandboxRoundResult,
  declaredOutputs: readonly string[],
): Promise<string[]> {
  const missing = declaredOutputs.filter((path) => result.outputs[path] === undefined);
  const record = {
    sandboxId: result.sandboxId,
    exitCode: result.exitCode,
    piExitCode: piExitCodeFrom(result.stdout) ?? null,
    outputs: declaredOutputs.map((path) => ({
      path,
      collected: result.outputs[path] !== undefined,
      sizeBytes: result.outputs[path]?.length ?? 0,
    })),
    stdoutTail: boundedTail(result.stdout, 4_000),
    stderrTail: boundedTail(result.stderr, 4_000),
  };
  await store.put(key, Buffer.from(`${JSON.stringify(record, null, 2)}\n`), "application/json");
  return missing;
}
