import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import authoringExtension from "../../src/extensions/authoring.js";

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

function tools(): Map<string, RegisteredTool> {
  const registered = new Map<string, RegisteredTool>();
  authoringExtension({
    registerTool: (tool: RegisteredTool) => registered.set(tool.name, tool),
  } as unknown as ExtensionAPI);
  return registered;
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

/** Answers mailbox requests like the worker supervisor would. */
function respond(green: (id: string) => boolean, stopped: { value: boolean }): Promise<void> {
  const requests = join(root, "mailbox/requests");
  const responses = join(root, "mailbox/responses");
  const seen = new Set<string>();
  return (async () => {
    while (!stopped.value) {
      const names = await readdir(requests).catch(() => [] as string[]);
      for (const name of names) {
        if (!name.endsWith(".json") || seen.has(name)) {
          continue;
        }
        seen.add(name);
        const id = name.slice(0, -5);
        const ok = green(id);
        await mkdir(responses, { recursive: true });
        await writeFile(
          join(responses, name),
          JSON.stringify({
            id,
            kind: "report",
            green: ok,
            summary: ok ? "green" : "red",
            rendered: `# report ${id}`,
          }),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  })();
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
    SELFBENCH_MAILBOX: join(root, "mailbox"),
    SELFBENCH_TASK_OUTPUT: join(root, "tasks"),
    SELFBENCH_DELIVERABLE: deliverable,
    SELFBENCH_VERIFY_BUDGET: "2",
    SELFBENCH_VERIFY_POLL_MS: "5",
    SELFBENCH_VERIFY_TIMEOUT_MS: "2000",
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
    const stopped = { value: false };
    let calls = 0;
    const responder = respond(() => {
      calls += 1;
      return calls === 2;
    }, stopped);

    const first = await verify.execute("1", {});
    expect(first.isError).toBeUndefined();
    expect(first.content[0]?.text).toContain("green=false. 1 verify call(s) remain");
    const second = await verify.execute("2", {});
    expect(second.content[0]?.text).toContain("green=true. 0 verify call(s) remain");
    const third = await verify.execute("3", {});
    expect(third.isError).toBe(true);

    const submitted = await submit.execute("4", {});
    expect(submitted.details).toEqual({ taskId: "ext-task", verified: true });
    const recorded = JSON.parse(
      await readFile(join(root, "tasks/ext-task/definition.json"), "utf8"),
    );
    expect(recorded.prompt).toBe("Implement the feature.");
    expect(await readFile(join(root, "tasks/ext-task/test.patch"), "utf8")).toBe("diff --git a b");
    stopped.value = true;
    await responder;
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
    expect(await readdir(join(root, "mailbox/requests")).catch(() => [])).toEqual([]);
  });

  test("marks a submission unverified when the files changed after the green verify", async () => {
    const registered = tools();
    const verify = registered.get("verify") as RegisteredTool;
    const submit = registered.get("submit_task") as RegisteredTool;
    await writeDeliverable();
    const stopped = { value: false };
    const responder = respond(() => true, stopped);

    await verify.execute("1", {});
    await writeDeliverable({ "test.patch": "diff --git a b\n+changed" });
    const submitted = await submit.execute("2", {});
    expect(submitted.details).toEqual({ taskId: "ext-task", verified: false });
    stopped.value = true;
    await responder;
  });
});
