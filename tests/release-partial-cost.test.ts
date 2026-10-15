import { expect, test } from "bun:test";
import { buildRelease, previewRelease } from "../src/public/release-build.js";
import { approvedTasks, inputs, run } from "./support/release-fixture.js";

test("public releases keep known spend but do not place incomplete settings on the frontier", () => {
  const source = inputs({
    tasks: approvedTasks(["t1", "t2"]),
    runs: [
      run({
        model: "sol",
        results: { t1: { apiCostUsd: 2 }, t2: { apiCostUsd: 1, costIncomplete: true } },
      }),
    ],
  });
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
    totalCostUsd: 3,
    costPerTaskUsd: 1.5,
    costIncomplete: true,
    costedTasks: 2,
    onFrontier: false,
  });
  expect(release.payload.frontier).toEqual([]);
});
