import { shellQuote } from "../lib/util.js";
import type { RemoteSandboxFile } from "./contracts.js";

/** Shell that downloads one remote file inside the sandbox and verifies its digest. */
export function remoteFileFetchScript(file: RemoteSandboxFile): string {
  const path = shellQuote(file.path);
  return [
    `mkdir -p "$(dirname ${path})"`,
    `curl -fsSL --retry 5 --retry-all-errors --connect-timeout 30 -o ${path} ${shellQuote(file.url)}`,
    `printf '%s  %s\\n' ${shellQuote(file.sha256)} ${path} | sha256sum -c - >/dev/null`,
  ].join(" && ");
}
