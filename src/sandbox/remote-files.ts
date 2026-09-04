import { createHash } from "node:crypto";
import {
  type InlineSandboxFile,
  isRemoteSandboxFile,
  type RemoteSandboxFile,
  type SandboxFile,
} from "./contracts.js";

/** Per-file budget for an in-sandbox download of a multi-hundred-MB bundle. */
export const REMOTE_FILE_FETCH_TIMEOUT_MS = 15 * 60_000;

/** Shell that downloads one remote file inside the sandbox and verifies its digest. */
export function remoteFileFetchScript(file: RemoteSandboxFile): string {
  const path = shellQuote(file.path);
  return [
    `mkdir -p "$(dirname ${path})"`,
    `curl -fsSL --retry 5 --retry-all-errors --connect-timeout 30 -o ${path} ${shellQuote(file.url)}`,
    `printf '%s  %s\\n' ${shellQuote(file.sha256)} ${path} | sha256sum -c - >/dev/null`,
  ].join(" && ");
}

/**
 * Fallback for providers without an in-sandbox download step: fetch each remote file on the
 * worker, verify it, and hand it over as inline contents.
 */
export async function materializeRemoteFiles(
  files: readonly SandboxFile[],
  signal?: AbortSignal,
): Promise<InlineSandboxFile[]> {
  const inline: InlineSandboxFile[] = [];
  for (const file of files) {
    if (!isRemoteSandboxFile(file)) {
      inline.push(file);
      continue;
    }
    const response = await fetch(file.url, signal ? { signal } : {});
    if (!response.ok) {
      throw new Error(
        `remote sandbox file ${file.path} failed to download: HTTP ${response.status}`,
      );
    }
    const contents = new Uint8Array(await response.arrayBuffer());
    const digest = createHash("sha256").update(contents).digest("hex");
    if (digest !== file.sha256) {
      throw new Error(
        `remote sandbox file ${file.path} digest mismatch: ${digest} != ${file.sha256}`,
      );
    }
    inline.push({ path: file.path, contents });
  }
  return inline;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
