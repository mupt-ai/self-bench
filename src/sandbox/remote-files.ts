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

/** Shell that prints `<sha256> <size>` of one file inside the sandbox; exits nonzero when absent. */
export function fileDigestScript(path: string): string {
  const quoted = shellQuote(path);
  return `test -f ${quoted} && printf '%s %s' "$(sha256sum < ${quoted} | cut -d' ' -f1)" "$(stat -c %s ${quoted})"`;
}

/**
 * Shell that PUTs one file from inside the sandbox to a signed upload URL. A 412 means an earlier
 * try already created the object; the caller checks it holds these bytes.
 */
export function fileUploadScript(
  path: string,
  target: { readonly url: string; readonly headers: Readonly<Record<string, string>> },
): string {
  const headers = Object.entries(target.headers).map(
    ([name, value]) => `-H ${shellQuote(`${name}: ${value}`)}`,
  );
  const curl = [
    "curl -sS --retry 5 --connect-timeout 30 -o /dev/null -w '%{http_code}'",
    ...headers,
    `-T ${shellQuote(path)}`,
    shellQuote(target.url),
  ].join(" ");
  return `status=$(${curl}) && case "$status" in 2??|412) ;; *) echo "upload failed: HTTP $status" >&2; exit 1 ;; esac`;
}
