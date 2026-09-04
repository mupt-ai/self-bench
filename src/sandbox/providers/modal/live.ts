import type { Sandbox } from "modal";
import type { LiveSandboxBacking } from "../../live.js";

type LiveModalSandbox = Pick<Sandbox, "exec" | "filesystem">;

/** execute/readFile/writeFile over a running Modal sandbox's second exec channel and filesystem. */
export function modalBacking(sandbox: LiveModalSandbox): LiveSandboxBacking {
  return {
    execute: async (command) => {
      const process = await sandbox.exec([...command], {});
      const [stdout, stderr, exitCode] = await Promise.all([
        readAll(process.stdout),
        readAll(process.stderr),
        process.wait(),
      ]);
      return { exitCode, stdout, stderr };
    },
    readFile: async (path) => {
      try {
        return await sandbox.filesystem.readBytes(path);
      } catch {
        return undefined;
      }
    },
    writeFile: async (path, contents) => {
      if (typeof contents === "string") {
        await sandbox.filesystem.writeText(contents, path);
      } else {
        await sandbox.filesystem.writeBytes(contents, path);
      }
    },
  };
}

async function readAll(stream: ReadableStream<string | Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (value !== undefined) {
        chunks.push(typeof value === "string" ? Buffer.from(value) : Buffer.from(value));
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}
