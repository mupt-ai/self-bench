import { expect, test } from "bun:test";
import { configurationPoint, defaultPicks, sharedTasks } from "./results-chart";
import { at, credentials, errored, NOW, passed, run } from "./results-fixture";
import { configurationsOf } from "./results-model";

const failed = (taskId: string) => ({ ...passed(taskId), rewards: { reward: 0 } });
const accepted = ["task-1", "task-2", "task-3", "task-4"].map((task) => `batch-1/${task}`);

const configurations = configurationsOf(
  [
    // Three of the four tasks.
    run("high", { thinking: "high" }, [passed("task-1"), failed("task-2"), passed("task-3")]),
    // Two of them; its re-run of task-2 errored, but its earlier pass still counts.
    run("medium", { thinking: "medium", createdAt: at(400) }, [passed("task-1"), passed("task-2")]),
    run("medium-again", { thinking: "medium", createdAt: at(300) }, [
      errored("task-2", "Worker interrupted or timed out before this trial completed"),
    ]),
    // Only the one task nobody else ran.
    run("low", { thinking: "low" }, [passed("task-4")]),
  ],
  credentials,
  NOW,
);
const byThinking = (thinking: string) => {
  const found = configurations.find((configuration) => configuration.thinking === thinking);
  if (!found) throw new Error(`Missing ${thinking}`);
  return found;
};
const [high, medium, low] = [byThinking("high"), byThinking("medium"), byThinking("low")];

test("chosen configurations chart over the accepted tasks all of them have a usable result on", () => {
  const shared = sharedTasks([high, medium], accepted);
  expect(shared).toEqual(["batch-1/task-1", "batch-1/task-2"]);
  expect(configurationPoint(high, shared)).toMatchObject({ accuracy: 50, cost: 0.5, tasks: 2 });
  expect(configurationPoint(medium, shared)).toMatchObject({ accuracy: 100, tasks: 2 });
  // Alone, a configuration charts over everything it ran.
  expect(configurationPoint(high, sharedTasks([high], accepted))).toMatchObject({
    accuracy: (2 / 3) * 100,
    tasks: 3,
  });
  expect(sharedTasks([high, low], accepted)).toEqual([]);
  expect(sharedTasks([], accepted)).toEqual([]);
});

test("the default leaves out a configuration that would shrink the chart", () => {
  // high and medium chart 2 points × 2 tasks; adding low would leave no shared task.
  expect(defaultPicks(configurations, accepted).map((entry) => entry.thinking)).toEqual([
    "high",
    "medium",
  ]);
});
