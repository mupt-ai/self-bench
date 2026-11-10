import { expect, test } from "bun:test";
import { orgUrlOf } from "./FailureExplanationForm";

test("Explain Failure reads the workspace's saved keys from any scope's evaluations", () => {
  for (const scope of [
    "repos/vercel/next.js",
    "benchmarks/laude-institute/terminal-bench",
    "groups/next-js-work",
  ])
    expect(orgUrlOf(`/api/orgs/mupt-ai/${scope}/evaluations`)).toBe("/api/orgs/mupt-ai");
});
