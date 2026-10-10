import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactStore } from "../artifacts/index.js";
import { platformModelKey } from "../generation/billing/managed.js";
import { expandBundle } from "../generation/runs/bundle.js";
import { evaluationPrefix } from "./store.js";
import type { EvaluationTrial, FailedTrial } from "./types.js";

/** The verifier's output files among a trial's collected or stored files. */
const VERIFIER_FILE = /\/verifier\/[^/]+\.(txt|json)$/;

interface FailureEvidence {
  /** The unpacked Harbor task: instruction.md, tests/test.patch, solution/gold.patch. */
  readonly taskPath: string;
  /** Harbor's jobs directory, which holds the solver's collected agent.patch. */
  readonly jobs: string;
  /** The trial's collected output by name (collectOutput), already redacted. */
  readonly files: ReadonlyMap<string, string>;
  readonly trial: Pick<EvaluationTrial, "rewards" | "agentTimedOut">;
}

/** What the summary model reads about one failed trial; any part may be missing. */
interface MaterialParts {
  readonly trial: Pick<EvaluationTrial, "rewards" | "agentTimedOut">;
  readonly instruction?: string | undefined;
  readonly tests?: string | undefined;
  readonly reference?: string | undefined;
  /** The verifier's output files by name. */
  readonly verifier: ReadonlyMap<string, string>;
  /** The agent's diff; empty when it changed nothing. */
  readonly changes?: string | undefined;
  /** In place of a diff that was never kept: the agent's tool calls from its transcript. */
  readonly actions?: string | undefined;
}

/**
 * What GPT-6 Luna reads about a completed trial that failed its tests (a reward of 0), gathered
 * while Harbor's files still exist; undefined when no summary will be written: the trial passed,
 * or this worker has no platform key. A failure here never touches the trial's result.
 */
export async function failureMaterial(
  { taskPath, jobs, files, trial }: FailureEvidence,
  { env, redact }: { env?: NodeJS.ProcessEnv | undefined; redact: (text: string) => string },
): Promise<string | undefined> {
  try {
    if (trial.rewards.reward !== 0 || !platformModelKey(env ?? process.env)) return undefined;
    const [instruction, tests, reference, changes] = await Promise.all([
      readText(join(taskPath, "instruction.md")),
      readText(join(taskPath, "tests", "test.patch")),
      readText(join(taskPath, "solution", "gold.patch")),
      agentPatch(jobs),
    ]);
    const verifier = new Map([...files].filter(([name]) => VERIFIER_FILE.test(name)));
    return redact(materialFrom({ trial, instruction, tests, reference, verifier, changes }));
  } catch (error) {
    console.warn("Failure material failed", error instanceof Error ? error.message : error);
    return undefined;
  }
}

/**
 * Material for a failed trial that kept none, because it ran before trials kept it or without
 * consent, rebuilt from what its evaluation stored: the task bundle, the verifier's output among
 * the trial's artifacts, and the tool calls in its transcript in place of its diff, which only
 * Harbor's run held.
 */
export async function storedFailureMaterial(
  store: ArtifactStore,
  { repoId, id }: Pick<FailedTrial, "repoId" | "id">,
  bundleKey: string,
  trial: EvaluationTrial,
): Promise<string> {
  const bundle = await expandBundle(store, bundleKey).then(
    ({ files }) => new Map(files.flatMap((file) => (file.text ? [[file.path, file.text]] : []))),
    () => new Map<string, string>(),
  );
  const artifacts = `${evaluationPrefix(repoId, id)}artifacts/`;
  const verifier = new Map(
    await Promise.all(
      trial.artifacts
        .filter((name) => VERIFIER_FILE.test(name))
        .map(async (name) => {
          const bytes = await store.getByKey(`${artifacts}${name}`);
          return [name, Buffer.from(bytes ?? []).toString("utf8")] as const;
        }),
    ),
  );
  const actions = trial.steps
    .flatMap((step) => step.tools.map((tool) => `${tool.name}: ${tool.input}`))
    .join("\n\n");
  return materialFrom({
    trial,
    instruction: bundle.get("instruction.md"),
    tests: bundle.get("tests/test.patch"),
    reference: bundle.get("solution/gold.patch"),
    verifier,
    actions,
  });
}

/** Where a failed trial's material waits for explainTrialFailure, beside its other artifacts. */
export function materialKey({ repoId, id, index }: Pick<FailedTrial, "repoId" | "id" | "index">) {
  return `${evaluationPrefix(repoId, id)}failures/${index}.md`;
}

/** Keeps a saved trial's failure material for explainTrialFailure; a failure only loses it. */
export async function keepFailureMaterial(
  store: ArtifactStore,
  trial: Pick<FailedTrial, "repoId" | "id" | "index">,
  material: string,
): Promise<void> {
  await store
    .put(materialKey(trial), Buffer.from(material), "text/markdown")
    .catch((error: unknown) =>
      console.warn("Failure material was not kept", error instanceof Error ? error.message : error),
    );
}

/** The material, each part cut to its share so no one part can crowd out the rest. */
function materialFrom({
  trial,
  instruction,
  tests,
  reference,
  verifier,
  changes,
  actions,
}: MaterialParts): string {
  const output = [...verifier]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, text]) => `${name.split("/").at(-1)}:\n${excerpt(text, 30_000)}`)
    .join("\n\n");
  const sections: [string, string | undefined, number][] = [
    ["instruction", instruction, 10_000],
    ["verifier_checks", JSON.stringify(trial.rewards), 2_000],
    [
      "time_limit",
      trial.agentTimedOut ? "The agent was stopped at its time limit." : undefined,
      200,
    ],
    ["verifier_output", output, 60_000],
    ["held_out_tests", tests, 30_000],
    ["agent_changes", changes === "" ? "The agent changed no files." : changes, 30_000],
    ["agent_tool_calls", actions, 30_000],
    ["reference_solution", reference, 20_000],
  ];
  return sections
    .flatMap(([name, text, limit]) =>
      text?.trim() ? [`<${name}>\n${excerpt(text.trim(), limit)}\n</${name}>`] : [],
    )
    .join("\n\n");
}

/** The start and the end of a long text, which hold a test run's first error and its summary. */
function excerpt(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.4);
  return `${text.slice(0, head)}\n[… ${text.length - limit} characters omitted …]\n${text.slice(-(limit - head))}`;
}

/** A task or Harbor file's text, up to a megabyte; undefined when it is missing. */
async function readText(path: string): Promise<string | undefined> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
  if (!file) return undefined;
  try {
    const stat = await file.stat();
    if (!stat.isFile()) return undefined;
    const buffer = Buffer.alloc(Math.min(stat.size, 1024 * 1024));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}

/**
 * The solver's diff, as the verifier applied it: the agent.patch Harbor collects into a trial's
 * artifacts (task.toml). Undefined when Harbor kept none.
 */
async function agentPatch(jobs: string): Promise<string | undefined> {
  const find = async (directory: string, depth: number): Promise<string | undefined> => {
    if (depth > 5) return undefined;
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name);
      if (entry.isFile() && entry.name === "agent.patch") return path;
      if (entry.isDirectory()) {
        const found = await find(path, depth + 1);
        if (found) return found;
      }
    }
    return undefined;
  };
  const trials = await readdir(join(jobs, "solver"), { withFileTypes: true }).catch(() => []);
  for (const trial of trials) {
    if (!trial.isDirectory()) continue;
    const path = await find(join(jobs, "solver", trial.name, "artifacts"), 0);
    if (path) return readText(path);
  }
  return undefined;
}
