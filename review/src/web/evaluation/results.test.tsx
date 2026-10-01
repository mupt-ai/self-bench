import { expect, test } from "bun:test";
import { facets, facetValues, matchingFacets, orderedConfigurations } from "./configuration-facets";
import { at, credentials, errored, NOW, passed, run } from "./results-fixture";
import { configurationsOf } from "./results-model";

test("groups runs by release setting, then by comparison, and counts each task's latest result", () => {
  const first = run("first", { comparisonId: "c1", createdAt: at(300) }, [
    passed("task-1"),
    errored("task-2", "Harbor exited with code 137"),
  ]);
  const rerun = run("rerun", { comparisonId: "c2", createdAt: at(100), startedBy: "sam" }, [
    passed("task-2"),
  ]);
  const other = run("other", { thinking: "low" }, [passed("task-1")]);
  const [configuration, low, ...rest] = configurationsOf([first, rerun, other], credentials, NOW);
  expect(rest).toEqual([]);
  expect(low?.thinking).toBe("low");
  expect(configuration?.batches.map((batch) => [batch.id, batch.startedBy])).toEqual([
    ["c1", "priya"],
    ["c2", "sam"],
  ]);
  expect(configuration?.latest.map((result) => [result.trial.taskId, result.outcome])).toEqual([
    ["task-1", "passed"],
    ["task-2", "passed"],
  ]);
  const replaced = configuration?.batches[0]?.results[1];
  expect(replaced?.outcome).toBe("error");
  expect(replaced?.replacedBy?.run.id).toBe("rerun");
  expect(configuration).toMatchObject({
    finished: 2,
    passRate: 100,
    costPerTask: 0.5,
    status: "done",
  });
});

test("custom endpoints serving one model are separate configurations, numbered as a release would", () => {
  const configurations = configurationsOf(
    [
      run("a", { credential: "gpu-a" }, [passed("task-1")]),
      run("b", { credential: "gpu-b" }, [passed("task-1")]),
    ],
    credentials,
    NOW,
  );
  expect(
    configurations
      .map((configuration) => [configuration.endpoint, configuration.endpointNumber])
      .sort(),
  ).toEqual([
    ["https://gpu.example.test/a/v1", 1],
    ["https://gpu.example.test/b/v1", 2],
  ]);
  expect(configurations[0]?.label).toBe("llama-70b");
});

test("running, queued and cancelled configurations", () => {
  const running = run("running", { status: "running" }, [
    passed("task-1"),
    { taskId: "task-2", status: "running", startedAt: at(5) },
    { taskId: "task-3" },
  ]);
  const queued = run("queued", { status: "queued", thinking: "low" }, [{ taskId: "task-1" }]);
  const cancelled = run(
    "cancelled",
    { status: "failed", error: "Cancelled by sam.", finishedAt: at(1), thinking: "medium" },
    [passed("task-1"), errored("task-2", "Cancelled before this trial completed")],
  );
  const configurations = configurationsOf([running, queued, cancelled], credentials, NOW);
  const status = Object.fromEntries(
    configurations.map((configuration) => [configuration.thinking, configuration.status]),
  );
  expect(status).toEqual({ high: "running", low: "queued", medium: "cancelled" });
  // Cancelled tasks didn't finish.
  expect(configurations.find((entry) => entry.thinking === "medium")?.finished).toBe(1);
});

test("a started run whose tasks are all still queued is running: it's preparing", () => {
  const preparing = run("preparing", { status: "running" }, [{ taskId: "task-1" }]);
  const waiting = run("waiting", { status: "queued", thinking: "low" }, [{ taskId: "task-1" }]);
  const configurations = configurationsOf([preparing, waiting], credentials, NOW);
  expect(configurations.map((configuration) => configuration.status).sort()).toEqual([
    "queued",
    "running",
  ]);
});

test("configurations narrow by facet and sort by any column", () => {
  const configurations = configurationsOf(
    [
      run("low", { thinking: "low" }, [
        passed("task-1"),
        { ...passed("task-2"), rewards: { reward: 0 } },
      ]),
      run("high", { thinking: "high" }, [passed("task-1"), passed("task-2")]),
      run("custom", { credential: "gpu-a" }, [{ ...passed("task-1"), apiCostUsd: 0.1 }]),
    ],
    credentials,
    NOW,
  );
  const reasoning = facets.find((facet) => facet.key === "reasoning");
  if (!reasoning) throw new Error("No reasoning facet");
  expect(facetValues(reasoning, configurations)).toEqual(["High", "Low"]);
  expect(
    matchingFacets(configurations, { vendor: ["Custom"] }).map((entry) => entry.label),
  ).toEqual(["llama-70b"]);
  expect(matchingFacets(configurations, { provider: ["OpenAI"], reasoning: ["Low"] })).toHaveLength(
    1,
  );
  // Any of a facet's values, and every facet: (Low or High) and OpenAI.
  expect(
    matchingFacets(configurations, { reasoning: ["Low", "High"], provider: ["OpenAI"] }),
  ).toHaveLength(2);
  const passRates = (descending: boolean) =>
    orderedConfigurations(configurations, { by: "pass", descending }).map(
      (entry) => entry.passRate,
    );
  expect(passRates(false)).toEqual([50, 100, 100]);
  expect(passRates(true)).toEqual([100, 100, 50]);
});
