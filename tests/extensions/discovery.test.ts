import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import discoveryExtension from "../../src/extensions/discovery.js";

test("discovery rejects unsafe candidate IDs before writing so the agent can correct them", async () => {
  let tool!: { parameters: unknown; execute: unknown };
  discoveryExtension({
    registerTool: (value) => {
      tool = value;
    },
  } as ExtensionAPI);
  const root = await mkdtemp(join(tmpdir(), "selfbench-discovery-"));
  const output = join(root, "discovery.json");
  const exclusions = join(root, "excluded.json");
  const previousOutput = process.env.SELFBENCH_DISCOVERY_OUTPUT;
  const previousExclusions = process.env.SELFBENCH_DISCOVERY_EXCLUSIONS;
  process.env.SELFBENCH_DISCOVERY_OUTPUT = output;
  process.env.SELFBENCH_DISCOVERY_EXCLUSIONS = exclusions;
  const candidate = {
    candidateId: "pr-123",
    difficulty: "easy",
    sourcePr: 123,
    sourceUrl: "https://github.com/example/repo/pull/123",
    baseCommit: "a".repeat(40),
    completedCommit: "b".repeat(40),
    provenance: { sourceType: "github-pull-request", sessionId: "pr-123", messageIndex: 0 },
  };
  const execute = tool.execute as unknown as (
    id: string,
    input: { candidates: (typeof candidate)[] },
  ) => Promise<unknown>;
  try {
    await writeFile(exclusions, "[]");
    const parameters = tool.parameters as unknown as {
      properties: { candidates: { items: { properties: { candidateId: { pattern: string } } } } };
    };
    expect(parameters.properties.candidates.items.properties.candidateId.pattern).toBe(
      "^[A-Za-z0-9][A-Za-z0-9._-]*$",
    );
    for (const candidateId of ["repo/pr-123", "PR #123", "../escape", "", "-prefix"]) {
      await expect(
        execute("invalid", { candidates: [{ ...candidate, candidateId }] }),
      ).rejects.toThrow("candidateId must start");
      expect(await Bun.file(output).exists()).toBe(false);
    }
    await execute("corrected", { candidates: [candidate] });
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({ candidates: [candidate] });
  } finally {
    if (previousOutput === undefined) delete process.env.SELFBENCH_DISCOVERY_OUTPUT;
    else process.env.SELFBENCH_DISCOVERY_OUTPUT = previousOutput;
    if (previousExclusions === undefined) delete process.env.SELFBENCH_DISCOVERY_EXCLUSIONS;
    else process.env.SELFBENCH_DISCOVERY_EXCLUSIONS = previousExclusions;
    await rm(root, { recursive: true, force: true });
  }
});
