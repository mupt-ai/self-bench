import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import authoringExtension from "../../src/extensions/authoring.js";

interface RegisteredTool {
  name: string;
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
  prompt: "Do it",
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
const savedEnvironment = { ...process.env };

function tools(): Map<string, RegisteredTool> {
  const registered = new Map<string, RegisteredTool>();
  authoringExtension({
    registerTool: (tool: RegisteredTool) => registered.set(tool.name, tool),
  } as unknown as ExtensionAPI);
  return registered;
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
            summary: ok ? "all gates green" : "oracle failed",
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
  const check = join(root, "check.js");
  await writeFile(
    check,
    [
      'const { readFileSync, mkdirSync } = require("node:fs");',
      "const [definitionPath, , , outputDirectory] = process.argv.slice(2);",
      'const definition = JSON.parse(readFileSync(definitionPath, "utf8"));',
      'const ok = definition.taskId !== "bad";',
      'mkdirSync(outputDirectory + "/rendered", { recursive: true });',
      'process.stdout.write(JSON.stringify({ ok, errors: ok ? [] : [{ gate: "audit", message: "over tier" }], renderedDirectory: outputDirectory + "/rendered" }) + "\\n");',
    ].join("\n"),
  );
  Object.assign(process.env, {
    SELFBENCH_CHECK_PROGRAM: check,
    SELFBENCH_RENDER_OUTPUT: root,
    SELFBENCH_MAILBOX: join(root, "mailbox"),
    SELFBENCH_TASK_OUTPUT: join(root, "tasks"),
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

describe("authoring extension verify tool", () => {
  test("enforces the per-session budget and records the green payload for submit_task", async () => {
    const registered = tools();
    const verify = registered.get("verify") as RegisteredTool;
    const submit = registered.get("submit_task") as RegisteredTool;
    const stopped = { value: false };
    let calls = 0;
    const responder = respond(() => {
      calls += 1;
      return calls === 2;
    }, stopped);
    const payload = { definition, testPatch: "diff --git a b", goldPatch: "diff --git c d" };

    const first = await verify.execute("1", payload);
    expect(first.isError).toBeUndefined();
    expect(first.content[0]?.text).toContain("# report");
    expect(first.content[0]?.text).toContain("green=false. 1 verify call(s) remain");

    const second = await verify.execute("2", payload);
    expect(second.content[0]?.text).toContain("green=true. 0 verify call(s) remain");
    expect(second.content[0]?.text).toContain("Call submit_task with exactly this payload");

    const third = await verify.execute("3", payload);
    expect(third.isError).toBe(true);
    expect(third.content[0]?.text).toContain("No verify calls remain");

    const submitted = await submit.execute("4", payload);
    expect(submitted.details).toEqual({ taskId: "ext-task", verified: true });
    expect(await readFile(join(root, "tasks/ext-task/test.patch"), "utf8")).toBe("diff --git a b");
    stopped.value = true;
    await responder;
    const requests = await readdir(join(root, "mailbox/requests"));
    expect(requests.filter((name) => name.endsWith(".json"))).toHaveLength(2);
  });

  test("returns static-check failures without spending the budget and marks unverified submissions", async () => {
    const registered = tools();
    const verify = registered.get("verify") as RegisteredTool;
    const submit = registered.get("submit_task") as RegisteredTool;
    const stopped = { value: false };
    const responder = respond(() => true, stopped);
    const bad = { definition: { ...definition, taskId: "bad" }, testPatch: "x", goldPatch: "y" };

    const rejected = await verify.execute("1", bad);
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0]?.text).toContain("[audit] over tier");
    expect(await readdir(join(root, "mailbox/requests")).catch(() => [])).toEqual([]);

    const good = { definition, testPatch: "diff --git a b", goldPatch: "diff --git c d" };
    const verified = await verify.execute("2", good);
    expect(verified.content[0]?.text).toContain("1 verify call(s) remain");

    const different = await submit.execute("3", { ...good, testPatch: "diff --git a b\n+changed" });
    expect(different.details).toEqual({ taskId: "ext-task", verified: false });
    expect(different.content[0]?.text).toContain("not verified green in this session");
    stopped.value = true;
    await responder;
  });

  test("reports a worker error without charging the budget", async () => {
    const registered = tools();
    const verify = registered.get("verify") as RegisteredTool;
    const requests = join(root, "mailbox/requests");
    const responses = join(root, "mailbox/responses");
    const stopped = { value: false };
    const responder = (async () => {
      while (!stopped.value) {
        for (const name of await readdir(requests).catch(() => [] as string[])) {
          if (name.endsWith(".json")) {
            await mkdir(responses, { recursive: true });
            await writeFile(
              join(responses, name),
              JSON.stringify({ id: name.slice(0, -5), kind: "error", message: "clone failed" }),
            );
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    })();

    const result = await verify.execute("1", {
      definition,
      testPatch: "diff --git a b",
      goldPatch: "diff --git c d",
    });

    expect(result.content[0]?.text).toBe("verify could not complete: clone failed");
    expect(result.details).toEqual({ kind: "error", remaining: 2 });
    stopped.value = true;
    await responder;
  });
});
