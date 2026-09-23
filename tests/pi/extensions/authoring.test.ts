import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import authoringExtension from "../../../src/harnesses/pi/extensions/authoring.js";

interface RegisteredTool {
  name: string;
  parameters: { properties?: Record<string, unknown> };
  execute: (
    toolCallId: string,
    input: Record<string, unknown>,
  ) => Promise<{
    content: { type: string; text: string }[];
    details?: Record<string, unknown>;
    isError?: boolean;
    terminate?: boolean;
  }>;
}

const definition = {
  schemaVersion: 2,
  difficulty: "easy",
  taskId: "ext-task",
  repo: "example/repo",
  baseCommit: "a".repeat(40),
  workdir: ".",
  testCommand: "bun test {tests}",
  failToPass: ["tests/a.test.ts"],
  passToPass: [],
  testPaths: ["tests/a.test.ts"],
  sourcePr: 1,
  sourceUrl: "https://github.com/example/repo/pull/1",
  timeouts: { setupSeconds: 1, agentSeconds: 1, testsSeconds: 1 },
  resources: { cpus: 1, memoryMb: 1, storageMb: 1 },
  environment: {
    schemaVersion: 1,
    baseImage: `x@sha256:${"b".repeat(64)}`,
    rootSetupCommand: "true",
    setupCommand: "true",
    smokeCommand: "true",
    environmentVariables: {},
    services: [],
    source: "generated",
    evidence: [{ path: "package.json", reason: "r" }],
  },
};

let root = "";
let deliverable = "";
const savedEnvironment = { ...process.env };

type ToolCallHook = () => { block: boolean; reason: string } | undefined;

function extension(): { tools: Map<string, RegisteredTool>; toolCall: ToolCallHook } {
  const tools = new Map<string, RegisteredTool>();
  let toolCall: ToolCallHook = () => undefined;
  authoringExtension({
    registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
    on: (event: string, handler: ToolCallHook) => {
      if (event === "tool_call") toolCall = handler;
    },
  } as unknown as ExtensionAPI);
  return { tools, toolCall: () => toolCall() };
}

function tools(): Map<string, RegisteredTool> {
  return extension().tools;
}

async function writeDeliverable(overrides: Partial<Record<string, string>> = {}): Promise<void> {
  await mkdir(deliverable, { recursive: true });
  const files: Record<string, string> = {
    "definition.json": JSON.stringify(definition),
    "instruction.md": "Implement the feature.\n",
    "test.patch": "diff --git a b",
    "gold.patch": "diff --git c d",
    ...overrides,
  };
  await Promise.all(
    Object.entries(files).map(([name, contents]) =>
      contents === undefined
        ? rm(join(deliverable, name), { force: true })
        : writeFile(join(deliverable, name), contents),
    ),
  );
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "selfbench-extension-"));
  deliverable = join(root, "task");
  const check = join(root, "check.js");
  await writeFile(
    check,
    [
      'const { readFileSync, mkdirSync } = require("node:fs");',
      "const [definitionPath, , , outputDirectory] = process.argv.slice(2);",
      'const definition = JSON.parse(readFileSync(definitionPath, "utf8"));',
      'const ok = definition.taskId !== "bad" && typeof definition.prompt === "string";',
      'mkdirSync(outputDirectory + "/rendered", { recursive: true });',
      'process.stdout.write(JSON.stringify({ ok, errors: ok ? [] : [{ gate: "audit", message: "over tier" }], renderedDirectory: outputDirectory + "/rendered" }) + "\\n");',
    ].join("\n"),
  );
  Object.assign(process.env, {
    SELFBENCH_CHECK_PROGRAM: check,
    SELFBENCH_RENDER_OUTPUT: root,
    SELFBENCH_VERIFY_REQUEST: join(root, "verify"),
    SELFBENCH_SUBMISSION: join(root, "submission"),
    SELFBENCH_DELIVERABLE: deliverable,
    SELFBENCH_VERIFY_BUDGET: "2",
  });
});

afterEach(async () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnvironment)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnvironment);
  await rm(root, { recursive: true, force: true });
});

describe("authoring extension directory deliverable", () => {
  test("tools take no arguments and read /work/task for verify and submit alike", async () => {
    const registered = tools();
    const verify = registered.get("verify") as RegisteredTool;
    const submit = registered.get("submit_task") as RegisteredTool;
    expect(Object.keys(verify.parameters.properties ?? {})).toEqual([]);
    expect(Object.keys(submit.parameters.properties ?? {})).toEqual([]);
    await writeDeliverable();

    const submitted = await submit.execute("1", {});
    expect(submitted.details).toEqual({ taskId: "ext-task" });
    expect(submitted.terminate).toBe(true);
    const recorded = JSON.parse(await readFile(join(root, "submission/definition.json"), "utf8"));
    expect(recorded.prompt).toBe("Implement the feature.");
    expect((await readFile(join(root, "submission/source-task.tar.gz"))).length).toBeGreaterThan(0);

    const requested = await tools().get("verify")?.execute("2", {});
    expect(requested?.isError).toBeUndefined();
    expect(requested?.terminate).toBe(true);
    expect(requested?.content[0]?.text).toContain("report arrives as your next message");
    expect(JSON.parse(await readFile(join(root, "verify/definition.json"), "utf8")).prompt).toBe(
      "Implement the feature.",
    );
  });

  test("verify ends the turn: every later tool call is blocked", async () => {
    const { tools: registered, toolCall } = extension();
    await writeDeliverable();
    expect(toolCall()).toBeUndefined();

    await registered.get("verify")?.execute("1", {});

    expect(toolCall()).toEqual(expect.objectContaining({ block: true }));
    const submitted = await registered.get("submit_task")?.execute("2", {});
    expect(submitted?.isError).toBe(true);
    expect(await readdir(join(root, "submission")).catch(() => [])).toEqual([]);
  });

  test("verify refuses once the round's budget is spent", async () => {
    process.env.SELFBENCH_VERIFY_BUDGET = "0";
    await writeDeliverable();
    const refused = await tools().get("verify")?.execute("1", {});
    expect(refused?.isError).toBe(true);
    expect(refused?.content[0]?.text).toContain("No verify calls remain");
    expect(await readdir(join(root, "verify")).catch(() => [])).toEqual([]);
  });

  test("reports missing or inconsistent deliverable files as static-check errors naming the file", async () => {
    const registered = tools();
    const verify = registered.get("verify") as RegisteredTool;
    const submit = registered.get("submit_task") as RegisteredTool;

    const nothing = await verify.execute("1", {});
    expect(nothing.isError).toBe(true);
    expect(nothing.content[0]?.text).toContain("[files] definition.json is missing");
    expect(nothing.content[0]?.text).toContain("[files] gold.patch is missing");

    await writeDeliverable({ "instruction.md": "   " });
    const empty = await submit.execute("2", {});
    expect(empty.isError).toBe(true);
    expect(empty.content[0]?.text).toContain("[files] instruction.md is empty");

    await writeDeliverable({
      "definition.json": JSON.stringify({ ...definition, prompt: "different" }),
    });
    const mismatch = await verify.execute("3", {});
    expect(mismatch.content[0]?.text).toContain("prompt differs from instruction.md");

    await writeDeliverable({ "definition.json": "{not json" });
    const invalid = await verify.execute("4", {});
    expect(invalid.content[0]?.text).toContain("[files] definition.json is not valid JSON");
    expect(await readdir(join(root, "verify")).catch(() => [])).toEqual([]);
  });
});
