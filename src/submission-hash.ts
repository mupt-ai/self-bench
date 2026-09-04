import { sha256 } from "./hash.js";

export interface SubmissionPayload {
  /** The definition as an object or its JSON text; hashed in compact canonical-order form. */
  readonly definition: unknown;
  readonly testPatch: string;
  readonly goldPatch: string;
}

/**
 * Identity of a submission for matching an in-session `verify` against the final `submit_task`
 * or `submit_fix` payload. The sandbox extension computes the same value over the same fields.
 */
export function submissionHash(payload: SubmissionPayload): string {
  const definition =
    typeof payload.definition === "string"
      ? JSON.stringify(JSON.parse(payload.definition))
      : JSON.stringify(payload.definition);
  return sha256(`${definition}\0${payload.testPatch}\0${payload.goldPatch}`);
}

export interface VerifyRecord {
  readonly hash: string;
  readonly green: boolean;
}

/** The last green in-session verify whose payload equals the submitted one, if any. */
export function matchingGreenVerify<T extends VerifyRecord>(
  submission: string,
  verifies: readonly T[],
): T | undefined {
  return [...verifies].reverse().find((record) => record.green && record.hash === submission);
}
