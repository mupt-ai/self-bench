import { expect, test } from "bun:test";
import { buildRelease, previewRelease } from "../src/public/release-build.js";
import { approvedTasks, inputs, run } from "./support/release-fixture.js";

test("a public release prices a setting by the mean of its priced tasks", () => {
  const source = inputs({
    tasks: approvedTasks(["t1", "t2"]),
    runs: [run({ model: "sol", results: { t1: { apiCostUsd: 2 }, t2: 1 } })],
  });
  // The second task has no price.
  delete source.runs[0]?.trials[1]?.apiCostUsd;
  const preview = previewRelease(source);
  const release = buildRelease(
    source,
    preview.settings.map((s) => s.key),
    {
      repository: { id: 1, fullName: "test/repo" },
      publisher: { login: "test", kind: "org" },
    },
  );
  expect(release.payload.settings[0]).toMatchObject({
    totalCostUsd: 2,
    costPerTaskUsd: 2,
    costedTasks: 1,
    onFrontier: true,
  });
});
