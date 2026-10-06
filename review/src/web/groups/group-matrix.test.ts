import { expect, test } from "bun:test";
import { passed, run, type TrialSpec } from "../evaluation/results-fixture";
import { groupMatrix } from "./group-matrix";

const failed = (taskId: string): TrialSpec => ({
  ...passed(taskId),
  rewards: { reward: 0 },
  apiCostUsd: 1.5,
});
const claude = { model: "custom", modelName: "openai/claude-ish", modelLabel: "claude-ish" };

test("each repository counts once in the average, each task once in the pooled rate", () => {
  const matrix = groupMatrix([
    // One task, passed: 100%.
    { fullName: "vercel/commerce", runs: [run("a", {}, [passed("cart")])] },
    // Three tasks, one passed: 33%.
    {
      fullName: "calcom/cal.com",
      runs: [run("b", {}, [passed("booking"), failed("slots"), failed("timezones")])],
    },
  ]);
  expect(matrix.columns).toHaveLength(1);
  const [column] = matrix.columns;
  if (!column) throw new Error("Missing column");
  expect(matrix.rows.map((row) => row.cells.get(column.key)?.passRate)).toEqual([
    100,
    (1 / 3) * 100,
  ]);
  expect(matrix.average.get(column.key)?.passRate).toBeCloseTo((100 + 100 / 3) / 2);
  expect(matrix.average.get(column.key)?.costPerTask).toBeCloseTo((0.5 + 3.5 / 3) / 2);
  expect(matrix.pooled.get(column.key)).toEqual({ passed: 2, scored: 4, passRate: 50 });
});

test("a setting one repository never ran is a column with an empty cell there", () => {
  const matrix = groupMatrix([
    {
      fullName: "vercel/commerce",
      runs: [
        run("a", {}, [passed("cart")]),
        run("c", { ...claude, credential: "gpu-a" }, [failed("cart")]),
      ],
    },
    { fullName: "dubinc/dub", runs: [run("b", {}, [passed("links")])] },
  ]);
  expect(matrix.columns.map((column) => column.label)).toEqual(["claude-ish", "GPT-6"]);
  const custom = matrix.columns[0]?.key ?? "";
  expect(matrix.rows[1]?.cells.has(custom)).toBe(false);
  expect(matrix.average.get(custom)).toEqual({ passRate: 0, costPerTask: 1.5, repos: 1 });
});
