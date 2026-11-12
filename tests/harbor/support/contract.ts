import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { conditionSchema } from "../../../src/contracts/conditions.js";
import { conditionArguments, runCondition } from "../../../src/evaluation/conditions.js";
import {
  gatewayModelId,
  gatewayTrial,
  pinnedThinking,
  subagentKey,
} from "../../../src/evaluation/gateway-trial.js";
import type { EvaluationInput, Harness } from "../../../src/evaluation/types.js";
import { gatewayConnection } from "../../../src/gateway/connection.js";
import { HARBOR_VERSION, harborPython } from "../../../src/harnesses/harbor/command.js";
import { runCommand } from "../../../src/lib/process.js";

/**
 * SelfBench's trials as the installed Harbor builds them: each harness's agent, made by Harbor's
 * own factory from the arguments and environment a trial passes `harbor run`, runs against a
 * sandbox that records what it is asked (support/harbor_contract.py). The other tests stand in for
 * Harbor, so they pass however Harbor changes; these fail when a Harbor upgrade changes what an
 * agent sends. CI installs the pinned Harbor and sets SELFBENCH_REQUIRE_HARBOR; without it, a
 * machine with no Harbor, or another version, skips them.
 */
const required = process.env.SELFBENCH_REQUIRE_HARBOR === "1";
export const python = await harborPython(process.env).catch(() => undefined);
const version = python
  ? (await runCommand(python, ["-c", "import harbor; print(harbor.__version__)"])).stdout.trim()
  : undefined;
const available = version === HARBOR_VERSION;
if (required && !available)
  throw new Error(`Harbor ${HARBOR_VERSION} is required; found ${version ?? "none"}`);

const source = fileURLToPath(new URL("../../../src/", import.meta.url));
const driver = fileURLToPath(new URL("./harbor_contract.py", import.meta.url));
const SECRET = "s".repeat(40);
const CREDENTIAL = "8d6b2c4e-1f3a-4b5c-9d7e-0a1b2c3d4e5f";
export const INSTRUCTION = "- Update the `display` style property.\n- It's done when tests pass.";
export let runtime: string;

/**
 * Packs the runtime modules as the server build does, with Pi's response capture beside them, for
 * the test file that calls it; each file that builds trials calls it once.
 */
export function packRuntime(): void {
  let packed: string | undefined;
  beforeAll(async () => {
    packed = await mkdtemp(join(tmpdir(), "selfbench-harbor-contract-"));
    const modules = join(source, "harnesses/harbor/runtime");
    for (const name of (await readdir(modules)).filter((file) => file.endsWith(".py")))
      await copyFile(join(modules, name), join(packed, name));
    await copyFile(join(source, "evaluation/dari/capture.cjs"), join(packed, "dari_capture.cjs"));
    runtime = packed;
  });
  afterAll(async () => {
    if (packed) await rm(packed, { recursive: true, force: true });
  });
}

interface Recorded {
  commands: { command: string; env: Record<string, string> }[];
  files: Record<string, string>;
}

export function input(provider: string, modelName: string): EvaluationInput {
  return {
    modelName,
    thinking: "high",
    credentials: { provider, auth: "api-key", modelCredentialId: CREDENTIAL },
  } as EvaluationInput;
}

/** The trial's agent as Harbor runs it, and the gateway key the trial carries. */
export async function run(
  trialInput: EvaluationInput,
  harness: Harness,
  env: NodeJS.ProcessEnv = {},
  condition?: unknown,
) {
  const thinking = pinnedThinking(harness, trialInput.thinking);
  const connection = gatewayConnection("https://api.selfbench.test", SECRET, {
    orgId: 7,
    credentialId: CREDENTIAL,
    model: gatewayModelId(trialInput),
    ...(trialInput.subagent ? { subagent: subagentKey(trialInput.subagent) } : {}),
    ...(thinking ? { thinking } : {}),
    tags: { run: "r1", trial: "r1/0", harness },
  });
  const trial = gatewayTrial(trialInput, harness, trialInput.modelName, env, connection);
  const result = await runCommand(python ?? "python3", [driver], {
    env: { PATH: process.env.PATH, HOME: tmpdir(), PYTHONPATH: runtime, HARBOR_TELEMETRY: "off" },
    input: JSON.stringify({
      agent: trial.agent,
      model: trial.model,
      // As harborRunArguments orders them: a condition's, then the trial's own.
      agentArguments: [
        ...conditionArguments(
          condition ? runCondition(conditionSchema.parse(condition)) : undefined,
          harness,
        ),
        ...trial.agentArguments,
      ],
      env: { HOME: tmpdir(), ...trial.child },
      instruction: INSTRUCTION,
    }),
  });
  expect(result.stderr.split("\n").filter((line) => line.includes("Error"))).toEqual([]);
  expect(result.exitCode).toBe(0);
  const recorded = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as Recorded;
  const start = (marker: string) => {
    const found = recorded.commands.filter((entry) => entry.command.includes(marker)).at(-1);
    if (!found) throw new Error(`No command runs ${marker}`);
    return found;
  };
  return { recorded, start, key: connection.key };
}

/** The arguments a shell command passes the program `name`, as the shell would split them. */
export function argv(command: string, name: string): string[] {
  const script = command.slice(command.indexOf(`${name} `)).split(" 2>&1 ")[0] ?? "";
  const words: string[] = [];
  for (const match of script.matchAll(/'((?:[^']|'"'"')*)'|(\S+)/g))
    words.push(match[1] === undefined ? (match[2] ?? "") : match[1].replaceAll(`'"'"'`, "'"));
  return words;
}

// Each test starts Harbor in Python, which imports it from source; a cold start in CI takes seconds.
export const harbor = (name: string, check: () => Promise<void>) =>
  test.skipIf(!available)(name, check, 60_000);
