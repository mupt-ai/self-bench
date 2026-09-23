import { z } from "zod";
import type { ArtifactRef } from "../contracts/index.js";
import type { ModelUsage, StartedSandbox } from "./contracts.js";

/**
 * The protocol between a started sandbox job and the callback API. The job uploads each output
 * under a relative name, heartbeats while it runs, and reports `done` with what it uploaded; the
 * API turns that into the activity's result.
 */

const fileName = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/);
const upload = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.number().int().nonnegative(),
  contentType: z.string().min(1).max(200),
});
const count = z.number().int().nonnegative();
const usage = z.object({
  input: count,
  output: count,
  cacheRead: count,
  cacheWrite: count,
  messages: count,
});

export const uploadRequestSchema = upload.extend({ name: fileName });

export const jobEventSchema = z.discriminatedUnion("kind", [
  /** `usage` is the model usage so far, for the live cost on progress pages. */
  z.object({ kind: z.literal("heartbeat"), usage: usage.optional() }),
  z.object({
    kind: z.literal("done"),
    exitCode: z.number().int(),
    files: z.record(fileName, upload),
    /** Small JSON outputs the job returns inline instead of uploading. */
    inline: z.record(fileName, z.unknown()).default({}),
    usage: usage.optional(),
    /** For agent jobs: the last assistant message and a provider error, from the session. */
    finalMessage: z.string().max(4_000).optional(),
    providerError: z.string().max(4_000).optional(),
  }),
  z.object({ kind: z.literal("failed"), message: z.string().max(4_000) }),
]);
type JobEvent = z.infer<typeof jobEventSchema>;
export type JobDone = Omit<Extract<JobEvent, { kind: "done" }>, "kind">;

/** What the API reports back when a job's sandbox says it is still wanted. */
export interface HeartbeatReply {
  readonly continue: boolean;
}

/** What a sandbox job produced. */
export interface SandboxJobOutcome {
  /** The sandbox that ran the job, still running until someone stops it. */
  readonly sandbox: StartedSandbox;
  /** The artifact folder the job wrote to. */
  readonly prefix: string;
  readonly exitCode: number;
  readonly files: Readonly<Record<string, ArtifactRef>>;
  readonly inline: Readonly<Record<string, unknown>>;
  readonly usage?: ModelUsage | undefined;
  readonly finalMessage?: string | undefined;
  readonly providerError?: string | undefined;
}

/** Where each named output of a job is stored. */
export function jobFileKey(prefix: string, name: string): string {
  return `${prefix}/${name}`;
}
