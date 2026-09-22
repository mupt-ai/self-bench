import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type SubmissionPayload, submissionHash } from "../../submission-hash.js";

const DEFAULT_MAILBOX = "/work/mailbox";
const DEFAULT_POLL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1_000;

export type VerifyOutcome =
  | {
      readonly kind: "report";
      readonly green: boolean;
      readonly summary: string;
      readonly rendered: string;
      readonly remaining: number;
    }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "exhausted" };

/**
 * Sandbox side of the worker mailbox: writes a verify request the supervising activity picks up,
 * then blocks until the response arrives. Reports consume the current round's budget; worker errors
 * and budget exhaustion do not.
 */
export class VerifyClient {
  readonly #mailbox = process.env.SELFBENCH_MAILBOX ?? DEFAULT_MAILBOX;
  readonly #budget = Number(process.env.SELFBENCH_VERIFY_BUDGET ?? "0");
  readonly #pollMs = Number(process.env.SELFBENCH_VERIFY_POLL_MS ?? String(DEFAULT_POLL_MS));
  readonly #timeoutMs = Number(
    process.env.SELFBENCH_VERIFY_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS),
  );
  #used = 0;
  #sequence = 0;
  #lastGreenHash: string | undefined;

  get remaining(): number {
    return Math.max(0, this.#budget - this.#used);
  }

  /** Whether this exact payload was verified green in this authoring round. */
  verifiedGreen(payload: SubmissionPayload): boolean {
    return this.#lastGreenHash !== undefined && this.#lastGreenHash === submissionHash(payload);
  }

  async verify(payload: SubmissionPayload): Promise<VerifyOutcome> {
    if (this.remaining === 0) {
      return { kind: "exhausted" };
    }
    const requests = join(this.#mailbox, "requests");
    const responses = join(this.#mailbox, "responses");
    mkdirSync(requests, { recursive: true });
    mkdirSync(responses, { recursive: true });
    this.#sequence += 1;
    const id = `${Date.now()}-${this.#sequence}`;
    const request = join(requests, `${id}.json`);
    writeFileSync(`${request}.tmp`, `${JSON.stringify({ id, kind: "task", ...payload })}\n`);
    renameSync(`${request}.tmp`, request);
    const response = join(responses, `${id}.json`);
    const deadline = Date.now() + this.#timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(response)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(response, "utf8"));
        } catch {
          parsed = undefined;
        }
        if (parsed && typeof parsed === "object") {
          return this.#record(parsed as Record<string, unknown>, payload);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, this.#pollMs));
    }
    this.#used += 1;
    return {
      kind: "error",
      message: `verify timed out after ${Math.round(this.#timeoutMs / 60_000)} minutes; the worker may still be building. ${this.remaining} verify call(s) remain.`,
    };
  }

  #record(response: Record<string, unknown>, payload: SubmissionPayload): VerifyOutcome {
    if (response.kind !== "report") {
      return {
        kind: "error",
        message:
          typeof response.message === "string" ? response.message : "verify failed on the worker",
      };
    }
    this.#used += 1;
    const green = response.green === true;
    if (green) {
      this.#lastGreenHash = submissionHash(payload);
    }
    return {
      kind: "report",
      green,
      summary: typeof response.summary === "string" ? response.summary : "",
      rendered: typeof response.rendered === "string" ? response.rendered : "",
      remaining: this.remaining,
    };
  }
}

export function verifyOutcomeText(outcome: VerifyOutcome): string {
  if (outcome.kind === "exhausted") {
    return `No verify calls remain in this authoring round. Call submit_task with your best task or explain in your final message why it cannot be made fair.`;
  }
  if (outcome.kind === "error") {
    return `verify could not complete: ${outcome.message}`;
  }
  const next = outcome.green
    ? `Call submit_task with exactly this payload to record it; the worker will reuse this report.`
    : `Fix the red gates and call verify again, or submit_task if you must (the worker verifies again and a round is spent if it fails).`;
  return `${outcome.rendered.trim()}\n\nverify result: green=${outcome.green}. ${outcome.remaining} verify call(s) remain in this authoring round. ${next}`;
}
