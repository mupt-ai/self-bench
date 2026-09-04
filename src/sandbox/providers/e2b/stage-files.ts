import {
  type InlineSandboxFile,
  isRemoteSandboxFile,
  type SandboxRequest,
} from "../../contracts.js";
import { REMOTE_FILE_FETCH_TIMEOUT_MS, remoteFileFetchScript } from "../../remote-files.js";
import { arrayBufferOf } from "./bytes.js";
import { raceWithTermination } from "./lifecycle.js";
import type { E2BSandboxHandle } from "./types.js";

/**
 * Puts the request's files in place before the command runs. Inline files are uploaded in one
 * `writeFiles` call and their bytes dropped afterwards (the request lives as long as the command,
 * hours). Remote files are pulled by the sandbox itself from their URL and digest-checked there,
 * so the worker never buffers or uploads large bundles; E2B recommends this over pushing them.
 */
export async function stageRequestFiles(
  sandbox: E2BSandboxHandle,
  request: SandboxRequest,
  signal: AbortSignal,
  termination: Promise<never>,
): Promise<void> {
  const files = request.files ?? [];
  const inlineFiles = files.filter((file): file is InlineSandboxFile => !isRemoteSandboxFile(file));
  const remoteFiles = files.filter(isRemoteSandboxFile);
  if (inlineFiles.length > 0) {
    await raceWithTermination(
      sandbox.files.writeFiles(
        inlineFiles.map((file) => ({
          path: file.path,
          data: typeof file.contents === "string" ? file.contents : arrayBufferOf(file.contents),
        })),
        { signal },
      ),
      termination,
    );
    for (const file of inlineFiles) {
      (file as { contents: string | Uint8Array }).contents = "";
    }
  }
  for (const file of remoteFiles) {
    // The SDK resolves a foreground run with its result and throws a CommandExitError (carrying
    // exitCode and stderr) on a non-zero exit; both shapes are reported the same way.
    let outcome: { exitCode?: number; stderr?: string };
    try {
      outcome = (await raceWithTermination(
        sandbox.commands.run(remoteFileFetchScript(file), {
          timeoutMs: REMOTE_FILE_FETCH_TIMEOUT_MS,
          signal,
        }),
        termination,
      )) as { exitCode?: number; stderr?: string };
    } catch (error) {
      if (typeof (error as { exitCode?: unknown }).exitCode !== "number") {
        throw error;
      }
      outcome = error as { exitCode?: number; stderr?: string };
    }
    if (outcome.exitCode !== 0) {
      throw new Error(
        `sandbox ${sandbox.sandboxId} could not fetch ${file.path}: exit ${outcome.exitCode}: ${(outcome.stderr ?? "").slice(-500)}`,
      );
    }
  }
}
