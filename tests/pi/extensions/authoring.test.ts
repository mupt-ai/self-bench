import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SUBMISSION_FILES } from "../../../src/generation/task/submission.js";
import authoringExtension from "../../../src/harnesses/pi/extensions/authoring.js";
import { runCommand } from "../../../src/lib/process.js";
import { submission } from "../../support/submission-fixture.js";

interface RegisteredTool {
  name: string;
  executionMode?: string;
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
  const { "services.sh": _services, ...required } = submission;
  const files = { ...required, "notes.txt": "scratch", ...overrides };
  await Promise.all(
    Object.entries(files).map(([name, contents]) => writeFile(join(deliverable, name), contents)),
  );
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "selfbench-extension-"));
  deliverable = join(root, "task");
  // Fails a deliverable whose instruction is "bad", and echoes what it was asked to check.
  const check = join(root, "check.js");
  await writeFile(
    check,
    [
      'const { readFileSync } = require("node:fs");',
      "const [directory, ...rest] = process.argv.slice(2);",
      'const ok = readFileSync(directory + "/instruction.md", "utf8").trim() !== "bad";',
      'process.stdout.write(JSON.stringify({ ok, errors: ok ? [] : [rest.join(" ")] }) + "\\n");',
    ].join("\n"),
  );
  Object.assign(process.env, {
    SELFBENCH_CHECK_PROGRAM: check,
    SELFBENCH_DIFFICULTY: "medium",
    SELFBENCH_REPO_DIRECTORY: join(root, "repo"),
    SELFBENCH_BASE_COMMIT: "a".repeat(40),
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
    expect(submitted.isError).toBeUndefined();
    expect(submitted.terminate).toBe(true);
    // Only the submission's own files are packed, never the author's scratch files, and
    // services.sh only when the author wrote one.
    const packed = await runCommand("tar", ["-tzf", join(root, "submission/source-task.tar.gz")]);
    expect(packed.stdout.trim().split("\n").sort()).toEqual(
      SUBMISSION_FILES.filter((name) => name !== "services.sh").sort(),
    );

    const requested = await tools().get("verify")?.execute("2", {});
    expect(requested?.isError).toBeUndefined();
    expect(requested?.terminate).toBe(true);
    expect(requested?.content[0]?.text).toContain("report arrives as your next message");
    expect(await readdir(join(root, "verify"))).toEqual(["source-task.tar.gz"]);
  });

  test("verify ends the turn: every later tool call is blocked", async () => {
    const { tools: registered, toolCall } = extension();
    await writeDeliverable();
    expect(toolCall()).toBeUndefined();

    await registered.get("verify")?.execute("1", {});

    expect(toolCall()).toEqual(expect.objectContaining({ block: true }));
    // A batch that mixes other tools with verify would prepare them all before verify ran.
    for (const name of ["verify", "submit_task"]) {
      expect(registered.get(name)?.executionMode).toBe("sequential");
    }
  });

  test("verify refuses once the round's budget is spent", async () => {
    process.env.SELFBENCH_VERIFY_BUDGET = "0";
    await writeDeliverable();
    const refused = await tools().get("verify")?.execute("1", {});
    expect(refused?.isError).toBe(true);
    expect(refused?.content[0]?.text).toContain("No verify calls remain");
    expect(await readdir(join(root, "verify")).catch(() => [])).toEqual([]);
  });

  test("the check runs at the candidate's tier and base, and a failure records nothing", async () => {
    await writeDeliverable({ "instruction.md": "bad" });
    const failed = await tools().get("verify")?.execute("1", {});
    expect(failed?.isError).toBe(true);
    expect(failed?.content[0]?.text).toContain(`- medium ${join(root, "repo")} ${"a".repeat(40)}`);
    expect(await readdir(join(root, "verify")).catch(() => [])).toEqual([]);
  });
});
