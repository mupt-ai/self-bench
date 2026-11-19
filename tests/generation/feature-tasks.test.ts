import { expect, test } from "bun:test";
import {
  type FeatureCandidate,
  featureCandidateSchema,
  type PullRequestCandidate,
} from "../../src/contracts/index.js";
import { planCandidates } from "../../src/generation/batches/record.js";
import type { GenerationBatch } from "../../src/generation/batches/types.js";
import { authoringPrompt } from "../../src/generation/pipeline/authoring.js";
import { discoveryPrompt } from "../../src/generation/pipeline/discovery.js";
import { featureRequest } from "../../src/generation/pipeline/feature-discovery.js";
import { taskSourceEnvironment } from "../../src/generation/pipeline/task-source.js";
import { taskToml } from "../../src/generation/task/render.js";
import { candidate, run } from "../support/workflow-fixture.js";

const artifact = { uri: "file:///p", sha256: "a".repeat(64), sizeBytes: 1, contentType: "x" };

function feature(id: string, prs: readonly number[], difficulty = "hard" as const) {
  return featureCandidateSchema.parse({
    kind: "feature",
    candidateId: id,
    difficulty,
    title: "Saved Searches",
    request: "People can save a search, list their saved searches, and rerun one.",
    pullRequests: prs.map((number, index) => ({
      number,
      url: `https://github.com/example/repo/pull/${number}`,
      title: `Saved searches part ${index + 1}`,
      mergeCommit: String(index + 1).repeat(40),
    })),
    baseCommit: "c".repeat(40),
    completedCommit: "d".repeat(40),
    provenance: artifact,
  });
}

test("a feature names each PR once, at its own canonical URL", () => {
  expect(() => feature("dup", [5, 5])).toThrow("each pull request once");
  expect(() =>
    featureCandidateSchema.parse({
      ...feature("bad-url", [5]),
      pullRequests: [
        {
          number: 5,
          url: "https://github.com/example/repo/pull/6",
          title: "x",
          mergeCommit: "1".repeat(40),
        },
      ],
    }),
  ).toThrow("matching number");
});

test("a feature's author builds the reference from its PRs and tests the feature end to end", () => {
  const saved = feature("saved-searches", [10, 14, 21]);
  const brief = authoringPrompt(saved, 1);
  expect(brief).toContain("# Build One Eval Task from a Feature");
  expect(brief).toContain(`Base commit: ${"c".repeat(40)}`);
  expect(brief).toContain(
    `- #14 Saved searches part 2 (https://github.com/example/repo/pull/14), landed as ${"2".repeat(40)}`,
  );
  expect(brief).toContain("git cherry-pick");
  expect(brief).toContain("# Test the Feature End to End");
  expect(brief).toContain(saved.request);
  expect(brief).not.toContain("{{");
  expect(authoringPrompt(saved, 2, "report")).toContain("re-cloned");
  // Its patches apply to its base under a PR's audit, whose tiers measure the reference's size.
  expect(taskSourceEnvironment(saved)).toEqual({ SELFBENCH_BASE_COMMIT: "c".repeat(40) });
});

test("feature discovery groups recent PRs, or searches the whole history for a requested feature", () => {
  const shard = {
    wave: 0,
    shardIndex: 0,
    shardCount: 1,
    targetCounts: { easy: 0, medium: 0, hard: 2 },
    excludedSourcePrs: [],
  };
  const open = discoveryPrompt({ ...shard, run: { ...run, unit: "feature" } }, 200);
  expect(open).toContain("# Find Features to Benchmark");
  expect(open).toContain("two or more merged pull requests");
  expect(open).toContain("Call submit_features");
  expect(open).not.toContain("# The Requested Feature");
  expect(open).not.toContain("{{");

  const requested = discoveryPrompt(
    { ...shard, run: { ...run, unit: "feature", focus: "Session replay ``` network capture" } },
    400,
  );
  expect(requested).toContain("one or more merged pull requests");
  expect(requested).toContain("gh pr list --state merged --search");
  expect(requested).toContain("```text\nSession replay ''' network capture\n```");
  expect(requested.indexOf("# The Requested Feature")).toBeLessThan(
    requested.indexOf("Call submit_features"),
  );
});

test("a feature's request is the summary, then each PR's own words where the index has them", () => {
  const request = featureRequest(
    "Saved searches.",
    [
      { number: 10, title: "Add saved searches" },
      { number: 14, title: "List saved searches" },
    ],
    [
      {
        sourceType: "github-pull-request",
        sessionId: "github:example/repo#10",
        messageIndex: 0,
        content: "Add saved searches\n\nStores a search per user.",
        sourcePr: 10,
        sourceUrl: "https://github.com/example/repo/pull/10",
      },
    ],
  );
  expect(request).toBe(
    "Saved searches.\n\n## Pull Requests\n\n### #10: Add saved searches\n\nAdd saved searches\n\nStores a search per user.\n\n### #14: List saved searches",
  );
});

test("planning gives each PR to one task: a feature loses to any earlier claim on its PRs", () => {
  const shard = (candidates: (PullRequestCandidate | FeatureCandidate)[], index: number) => ({
    workflowId: `batch/discovery/${index}`,
    input: {
      run,
      wave: 0,
      shardIndex: index,
      shardCount: 2,
      targetCounts: { easy: 0, medium: 0, hard: 3 },
      excludedSourcePrs: [],
    },
    result: { candidates, report: artifact },
  });
  const batch: GenerationBatch = {
    run: { ...run, unit: "feature", candidateCounts: { easy: 0, medium: 0, hard: 3 } },
    taskQueue: "q",
    phase: "discovering",
    // Shards take turns newest window first, so the second shard's first pick goes first.
    shards: [
      shard([feature("older", [3, 7]), feature("separate", [30, 31])], 0),
      shard([feature("newer", [7, 8]), candidate("lone-pr", 31)], 1),
    ],
    candidates: [],
  };
  expect(planCandidates(batch)).toBe(true);
  // "older" shares #7 with "newer", and "separate" shares #31 with the PR claimed before it.
  expect(batch.candidates.map((item) => item.candidate.candidateId)).toEqual(["newer", "lone-pr"]);
});

test("a feature task's metadata names its title and every PR", () => {
  const toml = taskToml({
    taskId: "saved-searches",
    difficulty: "hard",
    repo: "example/repo",
    baseCommit: "c".repeat(40),
    feature: { title: "Saved Searches", sourcePrs: [10, 14, 21] },
  });
  expect(toml).toContain('source = "feature"');
  expect(toml).toContain('feature_title = "Saved Searches"');
  expect(toml).toContain("source_prs = [10, 14, 21]");
  expect(toml).toContain('description = "Build the feature: Saved Searches"');
});
