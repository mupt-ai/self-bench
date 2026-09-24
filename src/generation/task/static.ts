import type { HarborEnvironment } from "../../contracts/config/providers.js";
import { type TaskDefinition, taskDefinitionSchema } from "../../contracts/index.js";
import { errorMessage } from "../../lib/util.js";
import { auditTaskDefinition } from "./audit.js";
import { dependencyManifestPatch } from "./dependencies.js";
import { assertEnvironmentPolicy, assertServicesSupported } from "./environment-policy.js";
import { malformedPatchProblems } from "./patch.js";
import { assertSafePatchPaths, assertSafeTaskPaths } from "./paths.js";
import {
  agentDockerfile,
  bashScript,
  posixShellScript,
  serviceComposeYaml,
  smokeScript,
  taskToml,
  verifierDockerfile,
} from "./render.js";
import { verifierRuntimeFiles } from "./runtime-assets.js";
import { isBaseOnlyTestPatch } from "./test-patch.js";
import { solutionScript, testScript } from "./verifier.js";

type StaticCheckGate = "schema" | "policy" | "paths" | "patches" | "patch" | "audit" | "render";

export interface StaticCheckError {
  readonly gate: StaticCheckGate;
  readonly message: string;
}

/** Relative path → contents of every text file the compiler renders from a submission. */
type RenderedTaskFiles = Readonly<Record<string, string>>;

export interface StaticCheckResult {
  readonly ok: boolean;
  readonly errors: readonly StaticCheckError[];
  readonly rendered?: RenderedTaskFiles;
}

export interface StaticCheckInput {
  readonly definitionJson: string;
  readonly testPatch: string;
  readonly goldPatch: string;
  /** Where Harbor verifies the task; omitted, provider-specific checks are skipped. */
  readonly harborEnvironment?: HarborEnvironment;
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
  const { harborEnvironment } = input;
  if (harborEnvironment) {
    guard(errors, "policy", () =>
      assertServicesSupported(definition.environment, harborEnvironment),
    );
  }
  guard(errors, "paths", () => assertSafeTaskPaths(definition));
  for (const [patch, label] of [
    [input.testPatch, "test patch"],
    [input.goldPatch, "gold patch"],
  ] as const) {
    if (label === "test patch" && isBaseOnlyTestPatch(definition, patch)) continue;
    const problems = malformedPatchProblems(patch, label);
    errors.push(...problems.map((message) => ({ gate: "patches" as const, message })));
    if (problems.length === 0) {
      guard(errors, "paths", () => assertSafePatchPaths(patch, label));
    }
  }
  if (errors.length === 0) {
    const audit = auditTaskDefinition(definition, input.goldPatch, input.testPatch);
    errors.push(...audit.blockers.map((message) => ({ gate: "audit" as const, message })));
  }
  let rendered: RenderedTaskFiles | undefined;
  if (!errors.some((error) => error.gate === "patches")) {
    guard(errors, "render", () => {
      rendered = renderTaskFiles(definition, input.goldPatch, input.testPatch);
    });
  }
  return { ok: errors.length === 0, errors, ...(rendered ? { rendered } : {}) };
}

/**
 * Dry render of the Harbor tree (everything except the repository snapshot and the held-out
 * patch copies), mirroring src/harbor-task/compiler.ts so the agent can inspect what will be built.
 */
function renderTaskFiles(
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
    ...Object.fromEntries(
      Object.entries(verifierRuntimeFiles()).map(([path, content]) => [`tests/${path}`, content]),
    ),
    "tests/Dockerfile": verifierDockerfile(definition, dependencySetupPatch),
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

function parseDefinition(json: string, errors: StaticCheckError[]): TaskDefinition | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    errors.push({
      gate: "schema",
      message: `definition is not valid JSON: ${errorMessage(error)}`,
    });
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
    errors.push({ gate, message: errorMessage(error) });
  }
}
