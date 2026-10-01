import { expect, test } from "bun:test";
import { facets, facetValues, matchingFacets, orderedConfigurations } from "./configuration-facets";
import { at, credentials, errored, NOW, passed, run } from "./results-fixture";
import { configurationsOf } from "./results-model";

test("groups runs by release setting, then by run, and counts each task's latest result", () => {
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
    ["first", "priya"],
    ["rerun", "sam"],
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
  expect(
    matchingFacets(configurations, { route: ["OpenAI API Key"], reasoning: ["Low"] }),
  ).toHaveLength(1);
  // Any of a facet's values, and every facet: (Low or High) and an OpenAI API key.
  expect(
    matchingFacets(configurations, { reasoning: ["Low", "High"], route: ["OpenAI API Key"] }),
  ).toHaveLength(2);
  const route = facets.find((facet) => facet.key === "route");
  if (!route) throw new Error("No route facet");
  expect(facetValues(route, configurations)).toEqual(["OpenAI API Key", "Custom Endpoint"]);
  const passRates = (descending: boolean) =>
    orderedConfigurations(configurations, { by: "pass", descending }).map(
      (entry) => entry.passRate,
    );
  expect(passRates(false)).toEqual([50, 100, 100]);
  expect(passRates(true)).toEqual([100, 100, 50]);
});

test("a task's latest usable result counts, so a re-run that errors or is running doesn't hide it", () => {
  const first = run("first", { comparisonId: "c1", createdAt: at(300) }, [passed("task-1")]);
  const failedAgain = run("again", { comparisonId: "c2", createdAt: at(100), status: "failed" }, [
    errored("task-1", "Worker interrupted or timed out before this trial completed"),
  ]);
  const [errorLater] = configurationsOf([first, failedAgain], credentials, NOW);
  expect(errorLater?.latest.map((result) => [result.run.id, result.outcome])).toEqual([
    ["first", "passed"],
  ]);
  expect(errorLater?.batches[1]?.results[0]?.replacedBy?.run.id).toBe("first");
  expect(errorLater).toMatchObject({ passRate: 100, status: "done" });
  const runningAgain = run(
    "running",
    { comparisonId: "c3", createdAt: at(10), status: "running" },
    [{ taskId: "task-1", status: "running", startedAt: at(5) }],
  );
  const [rerunning] = configurationsOf([first, runningAgain], credentials, NOW);
  expect(rerunning?.latest[0]?.run.id).toBe("first");
  expect(rerunning?.underway.map((result) => result.run.id)).toEqual(["running"]);
  expect(rerunning?.status).toBe("running");
});
