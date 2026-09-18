import { z } from "zod";
import { taskOperation } from "./task-operation.js";

const patches = z.object({ testPatch: z.string(), goldPatch: z.string() });
export async function submissionPatches(sourceBundle: Uint8Array, signal?: AbortSignal) {
  const outputs = await taskOperation(
    "unpack",
    [{ path: "/work/source-task.tar.gz", contents: sourceBundle }],
    ["/work/patches.json"],
    signal,
  );
  const bytes = outputs["/work/patches.json"];
  if (!bytes) throw new Error("Submission sandbox returned no patches");
  return patches.parse(JSON.parse(Buffer.from(bytes).toString()));
}
