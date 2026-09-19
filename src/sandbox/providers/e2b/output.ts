import { createHash } from "node:crypto";
import { z } from "zod";
import { raceWithSignal } from "./lifecycle.js";
import type { E2BSandboxHandle } from "./types.js";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const READ_TIMEOUT_MS = 15_000;
const outputSchema = z.object({
  size: z.number().int().min(0).max(MAX_OUTPUT_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  data: z.string().max(4 * Math.ceil(MAX_OUTPUT_BYTES / 3)),
});

/** An independent, bounded read for small outputs when the provider's file API fails. */
export async function readOutputThroughCommand(
  sandbox: E2BSandboxHandle,
  path: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  signal.throwIfAborted();
  // Bound the read itself, including a file that grows after open. Never print a large archive
  // through the command stream. The digest and length make truncated replies fail closed.
  // `node -e script path` puts path at argv[1]; [eval] is a stack-trace label, not an argv entry.
  const script = `
const fs = require("node:fs"), crypto = require("node:crypto");
const fd = fs.openSync(process.argv[1], "r");
try {
  if (!fs.fstatSync(fd).isFile()) throw Error("output is not a regular file");
  const buffer = Buffer.alloc(${MAX_OUTPUT_BYTES + 1});
  let size = 0, count;
  while (size < buffer.length && (count = fs.readSync(fd, buffer, size, buffer.length - size, null))) size += count;
  if (size > ${MAX_OUTPUT_BYTES}) throw Error("output exceeds command read limit");
  const bytes = buffer.subarray(0, size);
  process.stdout.write(JSON.stringify({size, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), data: bytes.toString("base64")}));
} finally { fs.closeSync(fd); }
`;
  const quote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;
  const readSignal = AbortSignal.any([signal, AbortSignal.timeout(READ_TIMEOUT_MS)]);
  const result = await raceWithSignal(
    sandbox.commands.run(`node -e ${quote(script)} ${quote(path)}`, {
      timeoutMs: READ_TIMEOUT_MS,
      requestTimeoutMs: READ_TIMEOUT_MS,
      signal: readSignal,
    }),
    readSignal,
  );
  if (result.exitCode !== 0) throw new Error("sandbox output command failed");
  const output = outputSchema.parse(JSON.parse(result.stdout));
  const bytes = Buffer.from(output.data, "base64");
  if (
    bytes.length !== output.size ||
    bytes.toString("base64") !== output.data ||
    createHash("sha256").update(bytes).digest("hex") !== output.sha256
  ) {
    throw new Error("sandbox output command returned incomplete or corrupt bytes");
  }
  return bytes;
}
