import { expect, test } from "bun:test";
import { buildGroupRelease } from "../src/public/group-release-build.js";
import { previewRelease } from "../src/public/release-build.js";
import { approvedTasks, inputs, key, names, run } from "./support/release-fixture.js";

const members = [
  { id: 1, fullName: "calcom/cal.com" },
  { id: 2, fullName: "dubinc/dub" },
  { id: 3, fullName: "vercel/commerce" },
];
// Two tasks in each of the first two members; none of the third's were run.
const memberOf = new Map([
  [key("t1"), 1],
  [key("t2"), 1],
  [key("t3"), 2],
  [key("t4"), 2],
  [key("t5"), 3],
]);
const context = {
  group: { slug: "nextjs-apps", name: "Next.js Apps" },
  members,
  memberOf,
  publisher: { login: "acme", kind: "org" as const },
};

function release(results: Record<string, number>[]) {
  const all = inputs({
    tasks: approvedTasks(names(1, 5)).map((task) => ({ ...task, bundleKey: `tasks/${task.key}` })),
    runs: results.map((result, index) => run({ model: `m${index}`, results: result })),
  });
  return buildGroupRelease(
    all,
    previewRelease(all).settings.map((setting) => setting.key),
    { ...context, publishTasks: true },
  );
}

test("a group release scores every member's tasks as one benchmark", () => {
  const built = release([{ t1: 1, t2: 1, t3: 0, t4: 1 }]);
  const [setting] = built.payload.settings;
  if (!setting) throw new Error("No setting released");
  // Pooled: 3 of 4 tasks, across both members.
  expect(built.payload.tasks).toBe(4);
  expect(setting).toMatchObject({ tasks: 4, passed: 3, accuracy: 75 });
  // Each member's share adds up to the pooled numbers.
  expect(built.payload.breakdown).toEqual([
    {
      repositoryId: 1,
      tasks: 2,
      settings: [{ id: setting.id, passed: 2, accuracy: 100, costPerTaskUsd: 1, totalCostUsd: 2 }],
    },
    {
      repositoryId: 2,
      tasks: 2,
      settings: [{ id: setting.id, passed: 1, accuracy: 50, costPerTaskUsd: 1, totalCostUsd: 2 }],
    },
  ]);
  // A member with no task in the release is left out of it.
  expect(built.payload.group).toEqual({
    slug: "nextjs-apps",
    name: "Next.js Apps",
    members: members.slice(0, 2),
  });
  // Published tasks name their repository, for links to the right pull request.
  expect(built.detail.releasedTasks.map((task) => task.repository)).toEqual([
    "calcom/cal.com",
    "calcom/cal.com",
    "dubinc/dub",
    "dubinc/dub",
  ]);
});

test("the task set is what every ticked setting ran, in any member", () => {
  // The second model never ran t4, so both settings are scored over t1 to t3.
  const built = release([
    { t1: 1, t2: 1, t3: 1, t4: 1 },
    { t1: 0, t2: 1, t3: 1 },
  ]);
  expect(built.payload.tasks).toBe(3);
  expect(built.payload.breakdown.map((member) => member.tasks)).toEqual([2, 1]);
});
