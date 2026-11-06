import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  gatewayModelId,
  gatewayTrial,
  pinnedThinking,
} from "../../src/evaluation/gateway-trial.js";
import type { EvaluationInput, Harness } from "../../src/evaluation/types.js";
import { gatewayConnection } from "../../src/gateway/connection.js";
import { HARBOR_VERSION, harborPython } from "../../src/harnesses/harbor/command.js";
import { runCommand } from "../../src/lib/process.js";

/**
 * SelfBench's trials as the installed Harbor builds them: each harness's agent, made by Harbor's
 * own factory from the arguments and environment a trial passes `harbor run`, runs against a
 * sandbox that records what it is asked (support/harbor_contract.py). The other tests stand in for
 * Harbor, so they pass however Harbor changes; these fail when a Harbor upgrade changes what an
 * agent sends. CI installs the pinned Harbor and sets SELFBENCH_REQUIRE_HARBOR; without it, a
 * machine with no Harbor, or another version, skips them.
 */
const required = process.env.SELFBENCH_REQUIRE_HARBOR === "1";
const python = await harborPython(process.env).catch(() => undefined);
const version = python
  ? (await runCommand(python, ["-c", "import harbor; print(harbor.__version__)"])).stdout.trim()
  : undefined;
const available = version === HARBOR_VERSION;
if (required && !available)
  throw new Error(`Harbor ${HARBOR_VERSION} is required; found ${version ?? "none"}`);

const source = fileURLToPath(new URL("../../src/", import.meta.url));
const driver = fileURLToPath(new URL("./support/harbor_contract.py", import.meta.url));
const SECRET = "s".repeat(40);
const CREDENTIAL = "8d6b2c4e-1f3a-4b5c-9d7e-0a1b2c3d4e5f";
const INSTRUCTION = "- Update the `display` style property.\n- It's done when tests pass.";
let runtime: string;

beforeAll(async () => {
  // The runtime modules as the server build packs them, with Pi's response capture beside them.
  runtime = await mkdtemp(join(tmpdir(), "selfbench-harbor-contract-"));
  const modules = join(source, "harnesses/harbor/runtime");
  for (const name of (await readdir(modules)).filter((file) => file.endsWith(".py")))
    await copyFile(join(modules, name), join(runtime, name));
  await copyFile(join(source, "evaluation/dari/capture.cjs"), join(runtime, "dari_capture.cjs"));
});
afterAll(async () => {
  if (runtime) await rm(runtime, { recursive: true, force: true });
});

interface Recorded {
  commands: { command: string; env: Record<string, string> }[];
  files: Record<string, string>;
}

function input(provider: string, modelName: string): EvaluationInput {
  return {
    modelName,
    thinking: "high",
    credentials: { provider, auth: "api-key", modelCredentialId: CREDENTIAL },
  } as EvaluationInput;
}

/** The trial's agent as Harbor runs it, and the gateway key the trial carries. */
async function run(trialInput: EvaluationInput, harness: Harness, env: NodeJS.ProcessEnv = {}) {
  const thinking = pinnedThinking(harness, trialInput.thinking);
  const connection = gatewayConnection("https://api.selfbench.test", SECRET, {
    orgId: 7,
    credentialId: CREDENTIAL,
    model: gatewayModelId(trialInput),
    ...(thinking ? { thinking } : {}),
    tags: { run: "r1", trial: "r1/0", harness },
  });
  const trial = gatewayTrial(trialInput, harness, trialInput.modelName, env, connection);
  const result = await runCommand(python ?? "python3", [driver], {
    env: { PATH: process.env.PATH, HOME: tmpdir(), PYTHONPATH: runtime, HARBOR_TELEMETRY: "off" },
    input: JSON.stringify({
      agent: trial.agent,
      model: trial.model,
      agentArguments: trial.agentArguments,
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
function argv(command: string, name: string): string[] {
  const script = command.slice(command.indexOf(`${name} `)).split(" 2>&1 ")[0] ?? "";
  const words: string[] = [];
  for (const match of script.matchAll(/'((?:[^']|'"'"')*)'|(\S+)/g))
    words.push(match[1] === undefined ? (match[2] ?? "") : match[1].replaceAll(`'"'"'`, "'"));
  return words;
}

// Each test starts Harbor in Python, which imports it from source; a cold start in CI takes seconds.
const harbor = (name: string, check: () => Promise<void>) =>
  test.skipIf(!available)(name, check, 60_000);

harbor(
  "Codex on the gateway asks for the gateway's model id over HTTPS with the trial key",
  async () => {
    const { recorded, start, key } = await run(input("openai", "openai/gpt-6-sol"), "codex");
    const codex = start("codex exec");
    const args = argv(codex.command, "codex");
    expect(args[args.indexOf("--model") + 1]).toBe("dari/model/openai/gpt-6-sol");
    expect(args.slice(-2)).toEqual(["--", INSTRUCTION]);
    expect(codex.env).toMatchObject({
      OPENAI_API_KEY: key,
      OPENAI_BASE_URL: "https://api.selfbench.test/gateway/v1",
    });
    const config = recorded.files["/installed-agent/codex-home/config.toml"] ?? "";
    expect(config).toContain('model_provider = "gateway"');
    expect(config).toContain('base_url = "https://api.selfbench.test/gateway/v1"');
    expect(config).toContain("supports_websockets = false");
    expect(config).toContain('model_reasoning_summary = "none"');
    // GPT-6 Sol reads images, so Codex keeps its image tool.
    expect(config).not.toContain("view_image");
  },
);

harbor("Codex on a custom endpoint is not offered the image tool", async () => {
  // A router may have no model that reads images, and refuses a conversation holding one.
  const { recorded, start } = await run(input("custom", "openai/shift-1"), "codex");
  expect(argv(start("codex exec").command, "codex")).toContain("dari/model/custom/shift-1");
  const config = recorded.files["/installed-agent/codex-home/config.toml"] ?? "";
  expect(config).toMatch(/\[features\]\s*\nview_image = false/);
});

harbor(
  "Pi on the gateway reads the instruction as its prompt and the model's details",
  async () => {
    const { recorded, start, key } = await run(
      input("anthropic", "anthropic/claude-opus-5-5"),
      "pi",
    );
    const pi = start("pi --print");
    const args = argv(pi.command, "pi");
    expect(args.slice(args.indexOf("--provider"), args.indexOf("--provider") + 4)).toEqual([
      "--provider",
      "harbor-endpoint",
      "--model",
      "dari/model/anthropic/claude-opus-5-5",
    ]);
    expect(args.slice(-2)).toEqual(["--", INSTRUCTION]);
    expect(pi.env).toMatchObject({ OPENAI_API_KEY: key });
    const models = JSON.parse(recorded.files["/tmp/harbor-pi-agent/models.json"] ?? "{}");
    expect(models.providers["harbor-endpoint"]).toMatchObject({
      baseUrl: "https://api.selfbench.test/gateway/v1",
      apiKey: "$OPENAI_API_KEY",
      api: "openai-completions",
      models: [{ id: "dari/model/anthropic/claude-opus-5-5", name: "Claude Opus 5.5" }],
    });
    expect(models.providers["harbor-endpoint"].models[0].contextWindow).toBeGreaterThan(0);
  },
);

harbor("Claude Code on the gateway pins every tier to the gateway's model id", async () => {
  const { start, key } = await run(input("anthropic", "anthropic/claude-opus-5-5"), "claude-code");
  const claude = start("claude --verbose");
  expect(claude.env).toMatchObject({
    ANTHROPIC_API_KEY: key,
    ANTHROPIC_BASE_URL: "https://api.selfbench.test/gateway",
    ANTHROPIC_MODEL: "dari/model/anthropic/claude-opus-5-5",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "dari/model/anthropic/claude-opus-5-5",
  });
});

harbor("Mini-SWE-Agent on the gateway calls it with the trial key", async () => {
  const { start, key } = await run(input("openai", "openai/gpt-6-sol"), "mini-swe-agent");
  const mini = start("mini-swe-agent --yolo");
  expect(mini.command).toContain("--model=openai/dari/model/openai/gpt-6-sol ");
  expect(mini.command).toContain("api_base=https://api.selfbench.test/gateway/v1 ");
  expect(mini.env).toMatchObject({ OPENAI_API_KEY: key });
});

harbor(
  "Pi on Dari's router captures its prices and reads the instruction as its prompt",
  async () => {
    const env = { OPENAI_API_KEY: "dari-key", OPENAI_BASE_URL: "https://routing.dari.dev/v1" };
    const { recorded, start } = await run(input("dari", "dari/routing"), "pi", env);
    const args = argv(start("pi --print").command, "pi");
    expect(args).toContain("/logs/agent/dari_capture.cjs");
    expect(args.slice(args.indexOf("--provider"), args.indexOf("--provider") + 4)).toEqual([
      "--provider",
      "harbor-endpoint",
      "--model",
      "dari/routing",
    ]);
    expect(args.slice(-2)).toEqual(["--", INSTRUCTION]);
    const models = JSON.parse(recorded.files["/tmp/harbor-pi-agent/models.json"] ?? "{}");
    expect(models.providers["harbor-endpoint"].baseUrl).toBe("https://routing.dari.dev/v1");
  },
);

test("the worker image installs the Harbor version SelfBench supports", async () => {
  const dockerfile = await readFile(new URL("../../Dockerfile", import.meta.url), "utf8");
  expect(dockerfile).toContain(`ARG HARBOR_VERSION=${HARBOR_VERSION}\n`);
});

harbor(
  "Muse Code on a Meta sign-in runs signed in, off contributor mode, without web tools",
  async () => {
    const auth = join(runtime, "muse-auth.json");
    await writeFile(auth, '{"providers":{"meta":{"access_token":"t"}}}');
    const trialInput = {
      ...input("meta", "meta/muse-spark-1.3"),
      thinking: "max",
    } as EvaluationInput;
    trialInput.credentials = { ...trialInput.credentials, auth: "muse-login" } as never;
    const { recorded, start } = await run(trialInput, "muse-code", { MUSE_AUTH_JSON_PATH: auth });
    const muse = start("muse exec");
    expect(muse.command).toContain("--contributor-mode off");
    expect(muse.command).toContain("--disable-web-tools");
    expect(muse.command).toContain("--reasoning-effort max");
    // A key in the environment would win over the sign-in.
    expect(muse.env).not.toHaveProperty("META_API_KEY");
    const authFile = Object.keys(recorded.files).find((path) => path.endsWith("/muse/auth.json"));
    expect(authFile && recorded.files[authFile]).toContain("access_token");
    expect(muse.env.XDG_CONFIG_HOME && authFile?.startsWith(muse.env.XDG_CONFIG_HOME)).toBe(true);
  },
);

harbor("Muse Code on a Meta key runs with the key", async () => {
  const { start } = await run(input("meta", "meta/muse-spark-1.3"), "muse-code", {
    META_API_KEY: "meta-key",
  });
  const muse = start("muse exec");
  expect(muse.env.META_API_KEY).toBe("meta-key");
  expect(muse.command).toContain("--contributor-mode off");
});

harbor("Vercel allowlists a trial's hosts in a policy the installed SDK accepts", async () => {
  const script = `import sys
sys.path.insert(0, sys.argv[1])
from harbor.models.task.config import NetworkMode, NetworkPolicy
from selfbench_vercel import SelfBenchVercelEnvironment as Vercel
policy = Vercel._vercel_network_policy(NetworkPolicy(network_mode=NetworkMode.ALLOWLIST, allowed_hosts=["api.selfbench.test"]))
assert dict(policy.allow) == {"api.selfbench.test": ()}, policy
print("ok")
`;
  const result = await runCommand(python ?? "python3", ["-c", script, runtime]);
  expect(result.stderr).toBe("");
  expect(result.stdout.trim()).toBe("ok");
});
