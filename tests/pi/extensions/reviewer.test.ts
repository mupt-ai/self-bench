import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import reviewerExtension from "../../../src/harnesses/pi/extensions/reviewer.js";

test("reviewer exposes only verdict tools and records feedback without creating task files", async () => {
  const root = await mkdtemp(join(tmpdir(), "readonly-review-"));
  const previous = process.env.SELFBENCH_VERDICT_OUTPUT;
  process.env.SELFBENCH_VERDICT_OUTPUT = root;
  const tools = new Map<
    string,
    { execute(id: string, input: Record<string, unknown>): Promise<unknown> }
  >();
  reviewerExtension({
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
    const acceptTask = tools.get("accept_task");
    if (!acceptTask) throw new Error("accept_task tool was not registered");
    await expect(acceptTask.execute("call-2", { reason: "fair" })).rejects.toThrow(
      "already submitted",
    );
  } finally {
    if (previous === undefined) delete process.env.SELFBENCH_VERDICT_OUTPUT;
    else process.env.SELFBENCH_VERDICT_OUTPUT = previous;
    await rm(root, { recursive: true, force: true });
  }
});
