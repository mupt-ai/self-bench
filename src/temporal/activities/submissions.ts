import { submissionPatches } from "../../sandbox/submission.js";

export interface SubmissionFiles {
  readonly taskId: string | undefined;
  readonly definition: unknown;
  readonly testPatch: string;
  readonly goldPatch: string;
}

/** Parses a sandbox submission (definition.json bytes + source bundle); undefined when unreadable. */
export async function readSubmission(
  definitionBytes: Uint8Array,
  sourceBundle: Uint8Array,
): Promise<SubmissionFiles | undefined> {
  try {
    const definition = JSON.parse(Buffer.from(definitionBytes).toString("utf8")) as unknown;
    const patches = await submissionPatches(sourceBundle);
    const taskId = (definition as { taskId?: unknown } | null)?.taskId;
    return {
      taskId: typeof taskId === "string" && taskId ? taskId : undefined,
      definition,
      ...patches,
    };
  } catch {
    return undefined;
  }
}
