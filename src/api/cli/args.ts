import { readFile } from "node:fs/promises";
import { type ParseArgsConfig, parseArgs } from "node:util";
import { readConfig } from "./config.js";

export type Values = Record<string, string | boolean | string[] | undefined>;
type Options = NonNullable<ParseArgsConfig["options"]>;

/**
 * Where a command acts: a repository or eval (`--repo`), a Harbor benchmark (`--benchmark`), or a
 * repository group (`--group`), in the workspace `--org` names. `--json` prints the API's reply.
 */
const COMMON = {
  repo: { type: "string" },
  benchmark: { type: "string" },
  group: { type: "string" },
  org: { type: "string" },
  json: { type: "boolean", default: false },
} as const;

/** Parses a command's flags and positionals, with the shared scope and output flags. */
export function parse(args: string[], options: Options = {}) {
  const { values, positionals } = parseArgs({
    args,
    options: { ...COMMON, ...options },
    allowPositionals: true,
    strict: true,
  });
  return { values: values as Values, positionals };
}

export function flag(values: Values, name: string): string | undefined {
  const value = values[name];
  return typeof value === "string" ? value : undefined;
}

export function list(values: Values, name: string): string[] {
  const value = values[name];
  return Array.isArray(value) ? value : [];
}

/** A required positional, named in the error when it is missing. */
export function positional(positionals: string[], index: number, label: string): string {
  const value = positionals[index];
  if (!value) throw new Error(`${label} is required`);
  return value;
}

/** `OWNER/NAME`, split. */
function pair(value: string, label: string): [string, string] {
  const [owner, name, extra] = value.split("/");
  if (!owner || !name || extra !== undefined) throw new Error(`${label} must be OWNER/NAME`);
  return [owner, name];
}

const encode = (...parts: string[]) => parts.map(encodeURIComponent).join("/");

/** The workspace: `--org`, SELFBENCH_ORG, the one `login` chose, or the repository's owner. */
export function org(values: Values, owner?: string): string {
  const named = flag(values, "org") ?? process.env.SELFBENCH_ORG ?? readConfig().org ?? owner;
  if (!named) throw new Error("--org (or SELFBENCH_ORG) is required");
  return named;
}

/** `/api/orgs/<org>/repos/<owner>/<name>`, from `--repo`. */
export function repositoryPath(values: Values): string {
  const repo = flag(values, "repo");
  if (!repo) throw new Error("--repo OWNER/NAME is required");
  const [owner, name] = pair(repo, "--repo");
  return `/api/orgs/${encode(org(values, owner))}/repos/${encode(owner, name)}`;
}

/** The repository, benchmark, or group whose evaluations a command reads or starts. */
export function scopePath(values: Values): string {
  const benchmark = flag(values, "benchmark");
  const group = flag(values, "group");
  const named = [flag(values, "repo"), benchmark, group].filter(Boolean).length;
  if (named > 1) throw new Error("name one of --repo, --benchmark, or --group");
  if (benchmark)
    return `/api/orgs/${encode(org(values))}/benchmarks/${encode(...pair(benchmark, "--benchmark"))}`;
  if (group) return `/api/orgs/${encode(org(values))}/groups/${encode(group)}`;
  if (named === 0)
    throw new Error("--repo OWNER/NAME, --benchmark NAME, or --group SLUG is required");
  return repositoryPath(values);
}

/** `--NAME TEXT`, or `--NAME-file PATH` read as UTF-8. */
export async function textOption(values: Values, name: string): Promise<string | undefined> {
  const file = flag(values, `${name}-file`);
  if (file) return await readFile(file, "utf8");
  return flag(values, name);
}

/** A JSON flag: inline JSON, or `@FILE`. */
export async function jsonOption(values: Values, name: string): Promise<unknown> {
  const text = flag(values, name);
  if (text === undefined) return undefined;
  return JSON.parse(text.startsWith("@") ? await readFile(text.slice(1), "utf8") : text);
}

/** `RUN_ID/TASK_ID` as the API names a task. */
export function taskRef(value: string): { runId: string; taskId: string } {
  const at = value.indexOf("/");
  if (at < 1 || at === value.length - 1) throw new Error(`task must be RUN_ID/TASK_ID: ${value}`);
  return { runId: value.slice(0, at), taskId: value.slice(at + 1) };
}

export function taskPath(base: string, runId: string, taskId: string): string {
  return `${base}/tasks/${encode(runId, taskId)}`;
}
