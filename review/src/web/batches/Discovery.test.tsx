import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { BatchStatus } from "../batch-api";
import { Discovery } from "./Discovery";

const status = (overrides: Partial<BatchStatus> = {}): BatchStatus => ({
  runId: "batch-abc",
  phase: "discovering",
  requested: 3,
  requestedByDifficulty: { easy: 1, medium: 1, hard: 1 },
  discovered: 0,
  accepted: 0,
  rejected: 0,
  tasks: [],
  ...overrides,
});

test("shows a Discovery section above an empty task list while shards are running", () => {
  const html = renderToStaticMarkup(
    <Discovery
      status={status({
        discovery: {
          wave: 0,
          totalShards: 2,
          completedShards: 0,
          failedShards: 0,
          candidates: 0,
          shards: [
            { wave: 0, shardIndex: 0, attempt: 2 },
            { wave: 0, shardIndex: 1, attempt: 1, error: "401: User not found." },
          ],
        },
      })}
    />,
  );
  expect(html).toContain("Discovery");
  expect(html).toContain("0/2 Shards");
  expect(html).toContain("Shard 1 of 2");
  expect(html).toContain("grid-cols-[1rem_minmax(0,1fr)_auto]");
  expect(html).not.toContain("<details open");
  expect(html).toContain("Attempt 2");
  expect(html).toContain("In Progress");
  expect(html).toContain("Failed");
  expect(html).toContain("401: User not found.");
  expect(html).toContain("Waiting for agent output");
});

test("hides Discovery after generation when no shards ran", () => {
  expect(renderToStaticMarkup(<Discovery status={status({ phase: "authoring" })} />)).toBe("");
});

test("a preparing batch says it is collecting merged PRs before any shard exists", () => {
  const html = renderToStaticMarkup(<Discovery status={status({ phase: "preparing" })} />);
  expect(html).toContain("Collecting Merged PRs");
});
