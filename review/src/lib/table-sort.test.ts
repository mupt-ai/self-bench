import { expect, test } from "bun:test";
import { nextSort, sortRows } from "./table-sort";

test("a new column sorts its own way first; pressing it again flips it", () => {
  const byName = { key: "name", direction: "asc" } as const;
  expect(nextSort<string>(byName, "cost", "asc")).toEqual({ key: "cost", direction: "asc" });
  expect(nextSort<string>(byName, "accuracy", "desc")).toEqual({
    key: "accuracy",
    direction: "desc",
  });
  expect(nextSort<string>(byName, "name", "desc")).toEqual({ key: "name", direction: "desc" });
});

test("rows sort by value either way, and ties keep the order they came in", () => {
  const rows = [
    { id: "a", score: 2 },
    { id: "b", score: 1 },
    { id: "c", score: 2 },
  ];
  const ids = (sorted: typeof rows) => sorted.map((row) => row.id);
  expect(ids(sortRows(rows, (row) => row.score, "asc"))).toEqual(["b", "a", "c"]);
  expect(ids(sortRows(rows, (row) => row.score, "desc"))).toEqual(["a", "c", "b"]);
});
