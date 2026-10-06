import { expect, test } from "bun:test";
import { discoveryPrompt } from "../src/generation/pipeline/discovery.js";
import { run } from "./support/workflow-fixture.js";

const shard = {
  wave: 0,
  shardIndex: 0,
  shardCount: 1,
  targetCounts: { easy: 0, medium: 1, hard: 1 },
  excludedSourcePrs: [],
};

test("discovery keeps its rules and adds the requester's focus only when one is set", () => {
  const plain = discoveryPrompt({ ...shard, run }, 40);
  expect(plain).toContain("/work/provenance.jsonl holds 40 merged pull requests");
  expect(plain).not.toContain("# Focus");
  expect(plain).not.toContain("{{");

  const focused = discoveryPrompt(
    { ...shard, run: { ...run, focus: "Server actions ``` and middleware" } },
    40,
  );
  expect(focused).toContain("Skip PRs listed in /work/excluded-source-prs.json");
  expect(focused).toContain("# Focus");
  // The focus stays inside its quote, so it can't close the fence and add rules of its own.
  expect(focused).toContain("```text\nServer actions ''' and middleware\n```");
  expect(focused.indexOf("# Focus")).toBeLessThan(focused.indexOf("Call submit_discovery"));
});
