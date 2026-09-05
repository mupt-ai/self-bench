import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import verifierExtension from "../../src/extensions/verifier.js";
import { verifierRoundScript } from "../../src/temporal/activities/agent-scripts.js";
import { authoringResumePrompt } from "../../src/temporal/activities/prompts-authoring.js";

test("verifier exposes only verdict tools and records feedback without creating task files", async () => {
  const root = await mkdtemp(join(tmpdir(), "readonly-review-"));
  const previous = process.env.SELFBENCH_VERDICT_OUTPUT;
  process.env.SELFBENCH_VERDICT_OUTPUT = root;
  const tools = new Map<
    string,
    { execute(id: string, input: Record<string, unknown>): Promise<unknown> }
  >();
  verifierExtension({
    registerTool: (tool: {
      name: string;
      execute(id: string, input: Record<string, unknown>): Promise<unknown>;
    }) => tools.set(tool.name, tool),
  } as unknown as ExtensionAPI);
  try {
    expect([...tools.keys()]).toEqual(["accept_task", "submit_suggestions", "reject_task"]);
    await tools
      .get("submit_suggestions")
      ?.execute("call-1", { summary: "Too coupled", suggestions: "Use the public API" });
    expect(JSON.parse(await readFile(join(root, "verdict.json"), "utf8"))).toEqual({
      kind: "suggestions",
      summary: "Too coupled",
      suggestions: "Use the public API",
    });
    await expect(tools.get("accept_task")!.execute("call-2", { reason: "fair" })).rejects.toThrow(
      "already submitted",
    );
  } finally {
    if (previous === undefined) delete process.env.SELFBENCH_VERDICT_OUTPUT;
    else process.env.SELFBENCH_VERDICT_OUTPUT = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("verifier launcher has no shell or write tools and author receives review feedback", () => {
  const script = verifierRoundScript(false);
  const tools = /--tools ([^ ]+)/.exec(script)?.[1]?.split(",");
  expect(tools).toEqual([
    "read",
    "grep",
    "find",
    "ls",
    "accept_task",
    "submit_suggestions",
    "reject_task",
  ]);
  expect(script).not.toContain("/work/fix");
  expect(authoringResumePrompt(2, "GREEN report", "Remove private-helper coupling")).toContain(
    "Remove private-helper coupling",
  );
});
