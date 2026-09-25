import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApplicationFailure } from "@temporalio/common";
import { parse, stringify } from "smol-toml";
import { isRecord } from "../../lib/util.js";
import {
  guardHarborOutput,
  type HarborOutputGuard,
  HarborOutputLimitError,
} from "./output-guard.js";

/**
 * A task bundle reaches the worker from a sandbox, so the worker treats it as untrusted. Harbor
 * runs on the worker with provider credentials in its environment and copies host values into the
 * sandbox wherever a task asks for them: `${VAR}` in any `env` table of task.toml, and any `$VAR`
 * a `docker-compose.yaml` mentions (Modal's compose mode). The SelfBench compiler never emits
 * either; a bundle that does was not compiled by it and is refused before Harbor reads it.
 */
export class UnsafeHarborTaskError extends Error {
  constructor(message: string) {
    super(`task bundle refused: ${message}`);
    this.name = "UnsafeHarborTaskError";
  }
}

const TASK_TOML_MAX_BYTES = 64 * 1024;
const COMPOSE_MAX_BYTES = 256 * 1024;
/**
 * Keys whose values Harbor resolves against the host environment or acts on outside the sandbox.
 * Harbor ignores keys it does not know, so only these matter; older bundles keep their other keys.
 */
const HOST_KEYS = new Set(["env", "mcp_servers", "steps", "skills_dir"]);
/** Host values that are paths or locale, never credentials; compose may mention them. */
const HARMLESS_VARIABLES = new Set(["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL"]);
/** Harbor's own pattern for the host variables a compose file pulls in. */
const COMPOSE_REFERENCE =
  /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}|\$([A-Za-z_][A-Za-z0-9_]*)\b/g;

/** A task or trial that attacks the worker fails outright inside an activity; a retry repeats it. */
export function refuseWithoutRetry(error: unknown): never {
  if (error instanceof UnsafeHarborTaskError || error instanceof HarborOutputLimitError)
    throw ApplicationFailure.nonRetryable(error.message, error.name);
  throw error;
}

/**
 * Readies one Harbor run under `root` (whose `jobs/` holds its output): checks the task, and
 * guards the output directories. Harbor stages sandbox downloads in TMPDIR, so the run gets its
 * own under `root` where the guard sees them.
 */
export async function prepareHarborRun(
  taskDirectory: string,
  root: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<{ env: NodeJS.ProcessEnv; guard: HarborOutputGuard }> {
  const scratch = join(root, "tmp");
  await mkdir(scratch, { recursive: true });
  const child = { ...env, TMPDIR: scratch };
  await assertHostSafeTask(taskDirectory, child);
  return { env: child, guard: guardHarborOutput([join(root, "jobs"), scratch], signal) };
}

/**
 * Refuses a task that would pull host environment into the sandbox, and rewrites task.toml from
 * the parsed value so Harbor reads exactly what was checked.
 */
export async function assertHostSafeTask(
  taskDirectory: string,
  harborEnv: NodeJS.ProcessEnv,
): Promise<void> {
  const path = join(taskDirectory, "task.toml");
  const raw = await readFile(path);
  if (raw.byteLength > TASK_TOML_MAX_BYTES)
    throw new UnsafeHarborTaskError("task.toml is too large");
  let config: unknown;
  try {
    config = parse(raw.toString("utf8"));
  } catch {
    throw new UnsafeHarborTaskError("task.toml does not parse");
  }
  if (!isRecord(config)) throw new UnsafeHarborTaskError("task.toml is not a table");
  rejectHostKeys(config, "");
  await writeFile(path, stringify(config));

  for (const compose of await composeFiles(taskDirectory)) {
    if ((await stat(compose)).size > COMPOSE_MAX_BYTES)
      throw new UnsafeHarborTaskError("a compose file is too large");
    const text = await readFile(compose, "utf8");
    for (const match of text.matchAll(COMPOSE_REFERENCE)) {
      const name = match[1] ?? match[2] ?? "";
      if (harborEnv[name] !== undefined && !HARMLESS_VARIABLES.has(name)) {
        throw new UnsafeHarborTaskError(`a compose file references the host variable ${name}`);
      }
    }
  }
}

function rejectHostKeys(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) rejectHostKeys(item, `${path}[${index}]`);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const at = path ? `${path}.${key}` : key;
    // Metadata is free-form and Harbor only records it.
    if (at === "metadata") continue;
    if (HOST_KEYS.has(key)) throw new UnsafeHarborTaskError(`task.toml sets ${at}`);
    rejectHostKeys(child, at);
  }
}

async function composeFiles(taskDirectory: string): Promise<string[]> {
  const entries = await readdir(taskDirectory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /compose\.ya?ml$/i.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}
