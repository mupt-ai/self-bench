import { expect, test } from "bun:test";
import { runCondition } from "../src/evaluation/conditions.js";
import { buildRelease, previewRelease } from "../src/public/release-build.js";
import { approvedTasks, inputs, run } from "./support/release-fixture.js";

test("a release offers a saved harness's setting, named by it and not ticked until released", () => {
  const source = inputs({
    tasks: approvedTasks(["t1"]),
    runs: [
      run({ model: "sol", results: { t1: 1 } }),
      {
        ...run({ model: "sol", results: { t1: 1 } }),
        id: "conditioned",
        condition: runCondition({ name: "With Skills", skills: ["https://github.com/a/b"] }),
      },
    ],
  });
  const settings = previewRelease(source).settings;
  expect(settings.map((setting) => [setting.condition?.name, setting.ticked])).toEqual([
    [undefined, false],
    ["With Skills", false],
  ]);
  expect(settings[1]?.label).toEndWith("(With Skills)");
});

test("a release offers a repo ablation, named by it and not ticked until released", () => {
  const source = inputs({
    tasks: approvedTasks(["t1"]),
    runs: [
      run({ model: "sol", results: { t1: 1 } }),
      {
        ...run({ model: "sol", results: { t1: 0 } }),
        id: "ablated",
        condition: runCondition({ name: "No AGENTS.md", skills: [], environment: 7 }),
      },
    ],
  });
  const settings = previewRelease(source).settings;
  expect(settings.map((setting) => [setting.condition?.environment?.name, setting.ticked])).toEqual(
    [
      [undefined, false],
      ["No AGENTS.md", false],
    ],
  );
});

test("a repo ablation or a saved harness never takes a model's place on the frontier", () => {
  const source = inputs({
    tasks: approvedTasks(["t1"]),
    runs: [
      run({ model: "sol", results: { t1: 0 } }),
      {
        ...run({ model: "sol", results: { t1: 1 } }),
        id: "ablated",
        condition: runCondition({ name: "No AGENTS.md", skills: [], environment: 7 }),
      },
      {
        ...run({ model: "sol", results: { t1: 1 } }),
        id: "skilled",
        condition: runCondition({ name: "With Skills", skills: ["https://github.com/a/b"] }),
      },
    ],
  });
  const keys = previewRelease(source).settings.map((setting) => setting.key);
  const { settings } = buildRelease(source, keys, {
    repository: { id: 1, fullName: "a/b" },
    publisher: { login: "acme", kind: "org" },
  }).payload;
  expect(
    settings.map((setting) => [
      setting.ablation ?? setting.customHarness ?? "",
      setting.onFrontier,
    ]),
  ).toEqual(
    expect.arrayContaining([
      ["", true],
      ["No AGENTS.md", false],
      ["With Skills", false],
    ]),
  );
});
