import { auditTaskDefinition } from "./audit.js";
import { type TaskDefinition, taskDefinitionSchema } from "./contracts.js";
import { assertEnvironmentPolicy } from "./environment.js";
import { dependencyManifestPatch } from "./harbor-task/dependencies.js";
import { assertSafePatchPaths, assertSafeTaskPaths } from "./harbor-task/paths.js";
import {
  agentDockerfile,
  bashScript,
  posixShellScript,
  serviceComposeYaml,
  smokeScript,
  taskToml,
  verifierDockerfile,
} from "./harbor-task/render.js";
import { solutionScript, testScript } from "./harbor-task/verifier.js";
import { assertVerifierFix } from "./verifier-fix.js";

export type StaticCheckGate =
  | "schema"
  | "policy"
  | "paths"
  | "patches"
  | "audit"
  | "render"
  | "fix";

export interface StaticCheckError {
  readonly gate: StaticCheckGate;
  readonly message: string;
}

/** Relative path → contents of every text file the compiler renders from a submission. */
export type RenderedTaskFiles = Readonly<Record<string, string>>;

export interface StaticCheckResult {
  readonly ok: boolean;
  readonly errors: readonly StaticCheckError[];
  readonly rendered?: RenderedTaskFiles;
}

export interface StaticCheckInput {
  readonly definitionJson: string;
  readonly testPatch: string;
  readonly goldPatch: string;
  /** When present, the submission is a verifier fix and must stay within the fix boundary. */
  readonly original?: {
    readonly definitionJson: string;
    readonly testPatch: string;
    readonly goldPatch: string;
  };
}

/**
 * Every check that needs no Docker, run inside the sandbox at submit time so the agent fixes
 * schema, policy, path, audit, and rendering problems in the same session. The worker repeats
 * these checks; only real build, smoke, nop, and oracle failures cost a round.
 */
export function staticCheckSubmission(input: StaticCheckInput): StaticCheckResult {
  const errors: StaticCheckError[] = [];
  const definition = parseDefinition(input.definitionJson, errors);
  if (!definition) {
    return { ok: false, errors };
  }
  guard(errors, "policy", () => assertEnvironmentPolicy(definition.environment));
  guard(errors, "paths", () => assertSafeTaskPaths(definition));
  if (!input.testPatch.startsWith("diff --git ")) {
    errors.push({
      gate: "patches",
      message: "test patch must be a Git patch starting with diff --git",
    });
  } else {
    guard(errors, "paths", () => assertSafePatchPaths(input.testPatch, "test patch"));
  }
  if (!input.goldPatch.startsWith("diff --git ")) {
    errors.push({
      gate: "patches",
      message: "gold patch must be a Git patch starting with diff --git",
    });
  } else {
    guard(errors, "paths", () => assertSafePatchPaths(input.goldPatch, "gold patch"));
  }
  if (errors.length === 0) {
    const audit = auditTaskDefinition(definition, input.goldPatch, input.testPatch);
    errors.push(...audit.blockers.map((message) => ({ gate: "audit" as const, message })));
  }
  if (input.original) {
    guard(errors, "fix", () => {
      const original = taskDefinitionSchema.parse(JSON.parse(input.original?.definitionJson ?? ""));
      assertVerifierFix({
        original,
        fixed: definition,
        originalTestPatch: input.original?.testPatch ?? "",
        fixedTestPatch: input.testPatch,
        originalGoldPatch: input.original?.goldPatch ?? "",
        fixedGoldPatch: input.goldPatch,
      });
    });
  }
  let rendered: RenderedTaskFiles | undefined;
  guard(errors, "render", () => {
    rendered = renderTaskFiles(definition, input.goldPatch, input.testPatch);
  });
  return { ok: errors.length === 0, errors, ...(rendered ? { rendered } : {}) };
}

/**
 * Dry render of the Harbor tree (everything except the repository snapshot and the held-out
 * patch copies), mirroring src/harbor-task/compiler.ts so the agent can inspect what will be built.
 */
export function renderTaskFiles(
  definition: TaskDefinition,
  goldPatch: string,
  testPatch = "",
): RenderedTaskFiles {
  const dependencySetupPatch = dependencyManifestPatch(goldPatch);
  const preinstallGoldDependencies = dependencySetupPatch.length > 0;
  const verifierScript = testScript(definition, testPatch);
  return {
    "task.toml": taskToml(definition),
    "instruction.md": `${definition.prompt.trim()}\n`,
    "definition.json": `${JSON.stringify(definition, null, 2)}\n`,
    "environment/Dockerfile": agentDockerfile(definition),
    ...environmentScripts("environment", definition),
    "tests/Dockerfile": verifierDockerfile(definition, preinstallGoldDependencies),
    "tests/test.sh": verifierScript,
    "tests/task-test.sh": verifierScript,
    ...environmentScripts("tests", definition),
    ...(definition.environment.services.length > 0
      ? { "tests/docker-compose.yaml": serviceComposeYaml(definition) }
      : {}),
    ...(preinstallGoldDependencies ? { "tests/dependency-setup.patch": dependencySetupPatch } : {}),
    "solution/solve.sh": solutionScript(),
  };
}

function environmentScripts(directory: string, definition: TaskDefinition): RenderedTaskFiles {
  return {
    [`${directory}/root-setup.sh`]: posixShellScript(definition.environment.rootSetupCommand),
    [`${directory}/setup.sh`]: bashScript(definition.environment.setupCommand),
    [`${directory}/smoke.sh`]: smokeScript(definition),
  };
}

/** Human-readable summary for a tool result. */
export function formatStaticCheckErrors(errors: readonly StaticCheckError[]): string {
  return errors.map((error) => `- [${error.gate}] ${error.message}`).join("\n");
}

function parseDefinition(json: string, errors: StaticCheckError[]): TaskDefinition | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    errors.push({ gate: "schema", message: `definition is not valid JSON: ${messageOf(error)}` });
    return undefined;
  }
  const parsed = taskDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push({
        gate: "schema",
        message: `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      });
    }
    return undefined;
  }
  return parsed.data;
}

function guard(errors: StaticCheckError[], gate: StaticCheckGate, action: () => void): void {
  try {
    action();
  } catch (error) {
    errors.push({ gate, message: messageOf(error) });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
