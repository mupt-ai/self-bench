import { expect, test } from "bun:test";
import { taskSet } from "../../../../src/public/release-rule";
import { type ChartOption, chartOptions, chosenOptions, configurationPoint } from "./results-chart";
import { at, credentials, errored, NOW, passed, run } from "./results-fixture";
import { configurationsOf } from "./results-model";

const failed = (taskId: string) => ({ ...passed(taskId), rewards: { reward: 0 } });
const accepted = ["task-1", "task-2", "task-3", "task-4"].map((task) => `batch-1/${task}`);

const options = chartOptions(
  configurationsOf(
    [
      // Three of the four tasks.
      run("high", { thinking: "high" }, [passed("task-1"), failed("task-2"), passed("task-3")]),
      // Two of them; its re-run of task-2 errored, but its earlier pass still counts.
      run("medium", { thinking: "medium", createdAt: at(400) }, [
        passed("task-1"),
        passed("task-2"),
      ]),
      run("medium-again", { thinking: "medium", createdAt: at(300) }, [
        errored("task-2", "Worker interrupted or timed out before this trial completed"),
      ]),
      // Only the one task nobody else ran.
      run("low", { thinking: "low" }, [passed("task-4")]),
      // Nothing usable: not offered.
      run("none", { thinking: "minimal" }, [errored("task-1", "Sandbox failed to start")]),
    ],
    credentials,
    NOW,
  ),
  accepted,
);
const option = (thinking: string) => {
  const found = options.find((entry) => entry.configuration.thinking === thinking);
  if (!found) throw new Error(`Missing ${thinking}`);
  return found;
};
const [high, medium, low] = [option("high"), option("medium"), option("low")];
const thinking = (chosen: readonly ChartOption[]) =>
  chosen.map((entry) => entry.configuration.thinking).sort();

test("chosen configurations chart over the accepted tasks all of them have a usable result on", () => {
  expect(thinking(options)).toEqual(["high", "low", "medium"]);
  const shared = taskSet([high, medium], accepted);
  expect(shared).toEqual(["batch-1/task-1", "batch-1/task-2"]);
  expect(configurationPoint(high.configuration, shared)).toMatchObject({
    accuracy: 50,
    cost: 0.5,
    tasks: 2,
  });
  expect(configurationPoint(medium.configuration, shared)).toMatchObject({
    accuracy: 100,
    tasks: 2,
  });
  // Alone, a configuration charts over everything it ran.
  expect(configurationPoint(high.configuration, taskSet([high], accepted))).toMatchObject({
    accuracy: (2 / 3) * 100,
    tasks: 3,
  });
  expect(taskSet([high, low], accepted)).toEqual([]);
});

test("unknown task costs are never plotted as free", () => {
  const trial = { ...passed("task-1"), apiCostUsd: undefined };
  const configurations = configurationsOf([run("partial", {}, [trial])], credentials, NOW);
  const configuration = configurations[0];
  if (!configuration) throw new Error("Fixture configuration missing");
  expect(configurationPoint(configuration, ["batch-1/task-1"])).toBeUndefined();
  expect(configuration.costPerTask).toBeUndefined();
});

test("the default charts the group with the most results, and a saved choice replaces it", () => {
  // high alone charts 1 × 3; with medium, which covers part of its tasks, 2 × 2; low 1 × 1.
  expect(thinking(chosenOptions(options, undefined))).toEqual(["high", "medium"]);
  expect(thinking(chosenOptions(options, [low.configuration.key, "gone"]))).toEqual(["low"]);
  // Clearing every box charts nothing; a choice no longer offered falls back to the default.
  expect(chosenOptions(options, [])).toEqual([]);
  expect(thinking(chosenOptions(options, ["gone"]))).toEqual(["high", "medium"]);
});
