import { expect, test } from "bun:test";
import { buildRelease, previewRelease, ReleaseRefused } from "../src/public/release-build.js";
import { frontierOf } from "../src/public/release-rule.js";
import { approvedTasks, full, inputs, key, names, run } from "./support/release-fixture.js";

/**
 * Worked cases of the release rule. Unless a case says otherwise, the line's current release
 * covers tasks t1..t40 with settings s1..s10.
 */
const context = {
  repository: { id: 70107786, fullName: "vercel/next.js" },
  publisher: { login: "acme", kind: "org" as const },
};
const tPrev = names(1, 40);
const sPrev = names(1, 10).map((index) => `s${index.slice(1)}`);
const keyOf = (model: string, rest: string[] = ["codex", "openai", "api-key", "default", ""]) =>
  JSON.stringify([model, ...rest]);
const previous = (declined: string[] = []) => ({
  tasks: tPrev.map(key),
  settings: sPrev.map((model) => keyOf(model)),
  declined,
});
const ticked = (preview: ReturnType<typeof previewRelease>) =>
  preview.settings.filter((setting) => setting.ticked).map((setting) => setting.label);
const baseRuns = () => sPrev.map((model) => full(model, tPrev));

test("a first release pre-ticks nothing and lists every setting with its coverage", () => {
  const preview = previewRelease(inputs({ runs: baseRuns() }));
  expect(ticked(preview)).toEqual([]);
  expect(preview.settings).toHaveLength(10);
  expect(preview.settings[0]?.coverage).toHaveLength(40);
  expect(preview.tasks.every((task) => task.status === "new")).toBe(true);
});

test("a rejected task drops out, and a setting that lacked only it is ticked", () => {
  const runs = [
    ...baseRuns(),
    full(
      "s11",
      tPrev.filter((name) => name !== "t7"),
    ),
  ];
  const tasks = approvedTasks(tPrev).map((task) =>
    task.taskId === "t7" ? { ...task, state: "rejected" as const, runnable: false } : task,
  );
  const preview = previewRelease(inputs({ runs, tasks, previous: previous() }));
  expect(ticked(preview)).toHaveLength(11);
  expect(preview.removed.map((task) => task.taskId)).toEqual(["t7"]);
  const release = buildRelease(
    inputs({ runs, tasks, previous: previous() }),
    preview.settings.map((s) => s.key),
    context,
  );
  expect(release.payload.tasks).toBe(39);
});

test("a task everyone ran joins; the ticked set covers it", () => {
  const runs = sPrev.map((model) => full(model, names(1, 41)));
  const tasks = approvedTasks(names(1, 41));
  const preview = previewRelease(inputs({ runs, tasks, previous: previous() }));
  expect(ticked(preview)).toHaveLength(10);
  expect(preview.tasks.find((task) => task.taskId === "t41")?.status).toBe("new");
  const chosen = preview.settings.filter((setting) => setting.ticked).map((setting) => setting.key);
  expect(
    buildRelease(inputs({ runs, tasks, previous: previous() }), chosen, context).payload.tasks,
  ).toBe(41);
});

test("one setting lagging keeps the old task set; un-ticking it grows the set", () => {
  const runs = [...sPrev.slice(0, 9).map((model) => full(model, names(1, 43))), full("s10", tPrev)];
  const all = inputs({ runs, tasks: approvedTasks(names(1, 43)), previous: previous() });
  const preview = previewRelease(all);
  const chosen = preview.settings.filter((setting) => setting.ticked).map((setting) => setting.key);
  expect(chosen).toHaveLength(10);
  expect(buildRelease(all, chosen, context).payload.tasks).toBe(40);
  const without = buildRelease(
    all,
    chosen.filter((entry) => entry !== keyOf("s10")),
    context,
  );
  expect(without.payload.tasks).toBe(43);
  expect(without.detail.declined).toEqual([]);
});

test("a partial new setting is listed, not ticked; ticking it shrinks the task set", () => {
  const all = inputs({
    runs: [...baseRuns(), full("kimi", [...names(1, 10), "t41"])],
    tasks: approvedTasks(names(1, 41)),
    previous: previous(),
  });
  const preview = previewRelease(all);
  expect(ticked(preview)).not.toContain("KIMI");
  const chosen = [...preview.settings.filter((s) => s.ticked).map((s) => s.key), keyOf("kimi")];
  expect(buildRelease(all, chosen, context).payload.tasks).toBe(10);
});

test("a task released before, removed, and approved again is labelled returning", () => {
  const runs = sPrev.map((model) => full(model, tPrev));
  const prior = { ...previous(), tasks: tPrev.filter((name) => name !== "t7").map(key) };
  const preview = previewRelease(
    inputs({ runs, previous: prior, everReleased: new Set(tPrev.map(key)) }),
  );
  expect(preview.tasks.find((task) => task.taskId === "t7")?.status).toBe("returning");
  expect(ticked(preview)).toHaveLength(10);
});

test("a setting declined last time stays unticked", () => {
  const preview = previewRelease(inputs({ runs: baseRuns(), previous: previous([keyOf("s10")]) }));
  expect(ticked(preview)).toHaveLength(9);
  expect(ticked(preview)).not.toContain("S10");
});

test("every previous task removed behaves like a first release", () => {
  const tasks = approvedTasks(names(41, 45));
  const preview = previewRelease(
    inputs({ runs: sPrev.map((model) => full(model, names(41, 45))), tasks, previous: previous() }),
  );
  expect(ticked(preview)).toEqual([]);
  expect(preview.removed).toHaveLength(40);
});

test("disjoint or empty selections are refused", () => {
  const all = inputs({ runs: [full("a", names(1, 5)), full("b", names(6, 10))] });
  expect(() => buildRelease(all, [keyOf("a"), keyOf("b")], context)).toThrow(ReleaseRefused);
  expect(() => buildRelease(all, [], context)).toThrow(ReleaseRefused);
  expect(() => buildRelease(all, [keyOf("nobody")], context)).toThrow(ReleaseRefused);
});

test("a repeated trial counts once, and the later one wins", () => {
  const early = run({ model: "s1", createdAt: "2026-09-01T00:00:00Z", results: { t3: 0 } });
  const late = run({ model: "s1", createdAt: "2026-09-02T00:00:00Z", results: { t3: 1 } });
  for (const runs of [
    [early, late],
    [late, early],
  ]) {
    const all = inputs({ runs, tasks: approvedTasks(["t3"]) });
    const release = buildRelease(all, [keyOf("s1")], context);
    expect(release.payload.settings[0]?.passed).toBe(1);
    expect(release.payload.settings[0]?.tasks).toBe(1);
  }
});

test("failed, unverified, fractional, and costless trials are not results", () => {
  const partial = run({
    model: "s2",
    results: {
      t1: 1,
      t2: { status: "failed" },
      t3: { modelVerified: false },
      t4: { rewards: { reward: 0.5 } },
      t5: 1,
      t6: { apiCostUsd: Number.NaN },
      t7: { apiCostUsd: -1 },
    },
  });
  // A trial whose cost was never recorded.
  delete partial.trials[4]?.apiCostUsd;
  const all = inputs({ runs: [partial], tasks: approvedTasks(names(1, 7)) });
  expect(previewRelease(all).settings[0]?.coverage).toEqual([0]);
});

test("endpoints and sign-in types are separate settings; hosts stay private", () => {
  const all = inputs({
    runs: [
      full("qwen", ["t1"], { provider: "custom", credential: "host-a" }),
      full("qwen", ["t1"], { provider: "custom", credential: "host-b" }),
      full("sol", ["t1"], { credential: "key" }),
      full("sol", ["t1"], { credential: "chatgpt" }),
    ],
    tasks: approvedTasks(["t1"]),
  });
  const preview = previewRelease(all);
  expect(preview.settings).toHaveLength(4);
  const release = buildRelease(
    all,
    preview.settings.map((setting) => setting.key),
    context,
  );
  const text = JSON.stringify(release.payload);
  expect(text).not.toContain("a.example");
  expect(text).not.toContain("b.example");
  const custom = release.payload.settings.filter((setting) => setting.custom);
  expect(new Set(custom.map((setting) => setting.id)).size).toBe(2);
  expect(custom[0]?.model.name).toBe("qwen");
  expect(release.payload.settings.map((setting) => setting.signIn).sort()).toEqual([
    "api-key",
    "api-key",
    "api-key",
    "codex-login",
  ]);
});

test("the same inputs give the same hash, whatever the run order", () => {
  const runs = baseRuns();
  const all = inputs({ runs });
  const chosen = previewRelease(all).settings.map((setting) => setting.key);
  const first = buildRelease(all, chosen, context);
  const again = buildRelease(inputs({ runs: [...runs].reverse() }), [...chosen].reverse(), context);
  expect(again.hash).toBe(first.hash);
  expect(previewRelease(inputs({ runs: [...runs].reverse() })).fingerprint).toBe(
    previewRelease(all).fingerprint,
  );
});

test("an edited review note changes the fingerprint but not the release hash", () => {
  const runs = baseRuns();
  const all = inputs({ runs });
  const noted = inputs({
    runs,
    tasks: approvedTasks(tPrev).map((task) =>
      task.taskId === "t1" ? { ...task, note: "edited" } : task,
    ),
  });
  expect(previewRelease(noted).fingerprint).not.toBe(previewRelease(all).fingerprint);
  const chosen = previewRelease(all).settings.map((setting) => setting.key);
  expect(buildRelease(noted, chosen, context).hash).toBe(buildRelease(all, chosen, context).hash);
});

test("a setting whose only trials are on unapproved tasks is not listed", () => {
  const preview = previewRelease(inputs({ runs: [...baseRuns(), full("gone", ["t99"])] }));
  expect(preview.settings.map((setting) => setting.label)).not.toContain("GONE");
});

test("every released setting ran every released task; declined settings cover the task set", () => {
  const runs = [...baseRuns(), full("extra", tPrev), full("partial", names(1, 20))];
  const all = inputs({ runs });
  const chosen = sPrev.map((model) => keyOf(model));
  const release = buildRelease(all, chosen, context);
  expect(release.payload.settings.every((setting) => setting.tasks === 40)).toBe(true);
  expect(release.detail.declined).toEqual([keyOf("extra")]);
});

test("scores: accuracy is a percentage and cost is per task; frontier drops dominated settings", () => {
  const all = inputs({
    runs: [
      run({
        model: "cheap",
        results: {
          t1: { rewards: { reward: 1 }, apiCostUsd: 0.5 },
          t2: { rewards: { reward: 0 }, apiCostUsd: 0.5 },
        },
      }),
      run({ model: "best", results: { t1: { apiCostUsd: 3 }, t2: { apiCostUsd: 5 } } }),
      run({
        model: "worse",
        results: { t1: { apiCostUsd: 4 }, t2: { rewards: { reward: 0 }, apiCostUsd: 4 } },
      }),
    ],
    tasks: approvedTasks(["t1", "t2"]),
  });
  const chosen = previewRelease(all).settings.map((setting) => setting.key);
  const { payload } = buildRelease(all, chosen, context);
  const byLabel = Object.fromEntries(
    payload.settings.map((setting) => [setting.model.label, setting]),
  );
  expect(byLabel.CHEAP?.accuracy).toBe(50);
  expect(byLabel.CHEAP?.costPerTaskUsd).toBe(0.5);
  expect(byLabel.BEST?.costPerTaskUsd).toBe(4);
  expect(byLabel.BEST?.totalCostUsd).toBe(8);
  expect(byLabel.WORSE?.onFrontier).toBe(false);
  expect(payload.frontier.length).toBe(2);
  expect(
    frontierOf([
      { id: "x", accuracy: 1, costPerTaskUsd: 1 },
      { id: "y", accuracy: 1, costPerTaskUsd: 1 },
    ]),
  ).toEqual(new Set(["x", "y"]));
});

test("the public payload carries no task-level or private fields", () => {
  const all = inputs({ runs: baseRuns() });
  const { payload } = buildRelease(all, [keyOf("s1")], context);
  const text = JSON.stringify(payload);
  for (const hidden of ["gen", "t1", "priya", "sandbox", "modal", "pricing", "tokens"])
    expect(text).not.toContain(`"${hidden}`);
  expect(Object.keys(payload).sort()).toEqual(
    ["frontier", "publisher", "repository", "schemaVersion", "settings", "tasks"].sort(),
  );
});
