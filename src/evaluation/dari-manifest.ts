import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { DARI_REQUEST_IDS, dariRequestManifest } from "./dari-cost.js";
import { record } from "./output.js";

const MAX_LINE_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024 * 1024;

/** Read accounting events without retaining Pi's deltas, tool output or repeated conversation. */
export async function retainDariManifest(root: string, files: Map<string, string>): Promise<void> {
  const trials = await readdir(join(root, "solver"), { withFileTypes: true }).catch(() => []);
  const paths: string[] = [];
  for (const trial of trials) {
    const agent = `solver/${trial.name}/agent`;
    if (
      trial.isDirectory() &&
      (await lstat(join(root, agent)).catch(() => undefined))?.isDirectory()
    )
      paths.push(`${agent}/pi.txt`);
  }
  if (paths.length !== 1) return;
  const path = paths[0];
  if (!path) return;
  const file = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW).catch(
    () => undefined,
  );
  if (!file) return;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return;
    const replies: string[] = [];
    let line = "";
    let discarded = false;
    let started = false;
    let invalid = false;
    const finish = () => {
      if (discarded) {
        line = "";
        discarded = false;
        return;
      }
      if (!line.trim()) return;
      try {
        const event = record(JSON.parse(line));
        started = true;
        if (event.type === "message_end") {
          const message = record(event.message);
          if (message.role === "assistant") {
            // Content and usage are irrelevant to authenticated request-cost lookup.
            replies.push(
              JSON.stringify({
                type: "message_end",
                message: {
                  role: message.role,
                  provider: message.provider,
                  model: message.model,
                  responseId: message.responseId,
                },
              }),
            );
            if (replies.length > 100_000) invalid = true;
          }
        }
      } catch {
        if (started) invalid = true;
      }
      line = "";
    };
    // Decode across UTF-8 chunk boundaries; never buffer an unbounded tool or agent_end line.
    for await (const chunk of file.createReadStream({ encoding: "utf8", autoClose: false })) {
      for (const [index, part] of String(chunk).split("\n").entries()) {
        if (index > 0) finish();
        if (!discarded) {
          line += part;
          if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
            // A huge accounting event cannot be proven complete. Known non-accounting events
            // may be discarded, but never an unknown line or a message_end.
            if (
              !/^\s*\{\s*"type"\s*:\s*"(?:agent_end|agent_settled|message_start|message_update|turn_end|tool_execution_(?:start|update|end))"/.test(
                line,
              )
            )
              invalid = true;
            started = true;
            discarded = true;
            line = "";
          }
        }
      }
      if (invalid) return;
    }
    finish();
    if (invalid) return;
    const manifest = dariRequestManifest(new Map([[path, replies.join("\n")]]));
    if (manifest) files.set(DARI_REQUEST_IDS, JSON.stringify(manifest));
  } finally {
    await file.close();
  }
}
