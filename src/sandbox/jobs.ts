import { z } from "zod";
import type { ArtifactRef } from "../contracts/index.js";
import type { StartedSandbox } from "./contracts.js";

/**
 * The protocol between a started sandbox job and the callback API. The job uploads each output
 * under a flat name, heartbeats while it runs, and reports `done` with what it uploaded; the API
 * turns that into the activity's result.
 */

const fileName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const upload = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.number().int().nonnegative(),
  contentType: z.string().min(1).max(200),
});

export const uploadRequestSchema = upload.extend({ name: fileName });

export const jobEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("heartbeat") }),
  z.object({
    kind: z.literal("done"),
    exitCode: z.number().int(),
    /** Small structured output the job inlines instead of uploading. */
    result: z.unknown().optional(),
    files: z.record(fileName, upload),
  }),
  z.object({ kind: z.literal("failed"), message: z.string().max(4_000) }),
]);
type JobEvent = z.infer<typeof jobEventSchema>;
/** The file declarations a job sends with `done`. */
export type JobFiles = Extract<JobEvent, { kind: "done" }>["files"];

/** What the API reports back when a job's sandbox says it is still wanted. */
export interface HeartbeatReply {
  readonly continue: boolean;
}

/** What a sandbox job produced. */
export interface SandboxJobOutcome {
  /** The detached sandbox, still running until someone stops it; absent for attached runs. */
  readonly sandbox?: StartedSandbox;
  readonly exitCode: number;
  readonly result?: unknown;
  readonly files: Readonly<Record<string, ArtifactRef>>;
}

/** Where each named output of a job is stored. */
export function jobFileKey(prefix: string, name: string): string {
  return `${prefix}/${name}`;
}
