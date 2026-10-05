import { expect, test } from "bun:test";
import { configurationPoint, taskSets } from "./results-chart";
import { at, credentials, errored, NOW, passed, run } from "./results-fixture";
import { configurationsOf } from "./results-model";

const accepted = (taskId: string, minutesAgo: number) => ({
  runId: "batch-1",
  taskId,
  difficulty: "easy",
  acceptedAt: at(minutesAgo),
});

test("task sets nest by acceptance, and chart only the configurations covering all of one", () => {
  const failed = (taskId: string) => ({ ...passed(taskId), rewards: { reward: 0 } });
  const configurations = configurationsOf(
    [
      // Every task, the newest one included.
      run("high", { thinking: "high" }, [passed("task-1"), failed("task-2"), passed("task-3")]),
      // The two older tasks; its re-run of task-2 errored, but its earlier pass still counts.
      run("medium", { thinking: "medium", createdAt: at(400) }, [
        passed("task-1"),
        passed("task-2"),
      ]),
      run("medium-again", { thinking: "medium", createdAt: at(300) }, [
        errored("task-2", "Worker interrupted or timed out before this trial completed"),
      ]),
      // Only one of the two tasks accepted together: it covers no set.
      run("low", { thinking: "low" }, [passed("task-1")]),
    ],
    credentials,
    NOW,
  );
  const sets = taskSets(configurations, [
    accepted("task-1", 2000),
    accepted("task-2", 2000),
    accepted("task-3", 100),
  ]);
  expect(
    sets.map((set) => [set.tasks.length, set.configurations.map((entry) => entry.thinking).sort()]),
  ).toEqual([
    [3, ["high"]],
    [2, ["high", "medium"]],
  ]);
  const [newest, earlier] = sets;
  if (!newest || !earlier) throw new Error("Missing sets");
  const high = newest.configurations[0];
  if (!high) throw new Error("Missing configuration");
  expect(configurationPoint(high, newest)).toMatchObject({ accuracy: (2 / 3) * 100, tasks: 3 });
  expect(configurationPoint(high, earlier)).toMatchObject({ accuracy: 50, cost: 0.5, tasks: 2 });
});
