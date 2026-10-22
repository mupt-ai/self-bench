import { expect, test } from "bun:test";
import type { ArtifactStore } from "../../src/artifacts/index.js";
import { executionEnvironment } from "../../src/contracts/config/execution-environment.js";
import type { TaskImages } from "../../src/contracts/index.js";
import { notRunGates } from "../../src/generation/pipeline/harbor-gates.js";
import {
  type ReverifyDependencies,
  reverifyTaskImages,
} from "../../src/generation/tasks/task-image-reverify.js";
import type { ReviewedTask } from "../../src/generation/tasks/task-images.js";

const compiled = "runs/run-1/verify/task-1/compile/attempt-1/harbor-task.tar.gz";
const bundle = { uri: `gs://bucket/${compiled}`, sha256: "a".repeat(64), sizeBytes: 100 };
const store = { stat: async () => bundle } as unknown as ArtifactStore;
const task: ReviewedTask = {
  id: 1,
  runId: "run-1",
  taskId: "task-1",
  bundleKey: compiled,
  images: null,
  pipelineStatus: "accepted",
  reviewDecision: null,
  deletedAt: null,
};
const recorded: TaskImages = { provider: "e2b", agent: "tpl-agent", verifier: "tpl-verifier" };
const passed = {
  build: { ran: true, ok: true, infrastructure: false, logTail: "" },
  smoke: { ran: true, ok: true, logTail: "" },
  nop: { ran: true, ok: true, rewards: { reward: 0 }, logTail: "" },
  oracle: { ran: true, ok: true, rewards: { reward: 1 }, logTail: "" },
};

function deps(overrides: Partial<ReverifyDependencies> = {}): ReverifyDependencies {
  const unexpected = async (): Promise<never> => {
    throw new Error("unexpected side effect");
  };
  return {
    apply: true,
    provider: async () => "e2b",
    environment: async () => ({ E2B_API_KEY: "original-account" }),
    save: unexpected,
    export: unexpected,
    gates: unexpected,
    signal: new AbortController().signal,
    now: () => new Date("2026-10-22T00:00:00.000Z"),
    ...overrides,
  };
}

test("only accepted tasks without images, not rejected in review, are re-verified", async () => {
  const run = (row: ReviewedTask) => reverifyTaskImages(store, row, deps());
  expect((await run({ ...task, images: recorded })).status).toBe("skipped");
  expect((await run({ ...task, reviewDecision: "reject" })).status).toBe("skipped");
  expect((await run({ ...task, deletedAt: new Date() })).status).toBe("skipped");
  expect((await run({ ...task, pipelineStatus: "rejected" })).status).toBe("skipped");
});

test("a dry run resolves the original account but runs nothing", async () => {
  expect(await reverifyTaskImages(store, task, deps({ apply: false }))).toEqual({
    status: "planned",
    provider: "e2b",
  });
  const missing = deps({
    apply: false,
    environment: async () => {
      throw new Error("Original verification credential is unavailable");
    },
  });
  await expect(reverifyTaskImages(store, task, missing)).rejects.toThrow("credential");
});

test("images that pass every gate on the original account are recorded", async () => {
  const saved: TaskImages[] = [];
  const result = await reverifyTaskImages(
    store,
    task,
    deps({
      gates: async (_store, gated, provider, outputs) => {
        expect(gated).toEqual({
          taskId: "task-1",
          bundle: { ...bundle, contentType: "application/gzip" },
        });
        expect(provider).toBe("e2b");
        expect(outputs).toBe(
          "runs/run-1/verify/task-1/compile/attempt-1/reverify-2026-10-22T00-00-00-000Z",
        );
        expect(executionEnvironment().E2B_API_KEY).toBe("original-account");
        return { ...passed, images: recorded };
      },
      save: async (images) => {
        saved.push(images);
        return true;
      },
    }),
  );
  // Awaiting review: recorded, and exported only once a person approves it.
  expect(result).toEqual({ status: "recorded", provider: "e2b" });
  expect(saved).toEqual([recorded]);
});

test("an approved task is exported once its images are recorded", async () => {
  const calls: string[] = [];
  const result = await reverifyTaskImages(
    store,
    { ...task, reviewDecision: "approve" },
    deps({
      gates: async () => ({ ...passed, images: recorded }),
      save: async () => {
        calls.push("save");
        return true;
      },
      export: async (images) => {
        calls.push(`export ${images.agent}`);
        return { status: "exported", bundleKey: "runs/run-1/execution-task.tar.gz" };
      },
    }),
  );
  expect(result).toEqual({ status: "exported", bundleKey: "runs/run-1/execution-task.tar.gz" });
  expect(calls).toEqual(["save", "export tpl-agent"]);
});

test("a gate that fails again leaves the row unchanged", async () => {
  const failing = { ...notRunGates(), build: passed.build, smoke: passed.smoke };
  const result = await reverifyTaskImages(store, task, deps({ gates: async () => failing }));
  expect(result).toMatchObject({ status: "failed", gate: "nop" });
  // A green run that recorded no separate verifier image cannot be delivered by digest.
  const agentOnly = { ...passed, images: { provider: "e2b" as const, agent: "tpl-agent" } };
  expect(
    await reverifyTaskImages(store, task, deps({ gates: async () => agentOnly })),
  ).toMatchObject({ status: "failed", gate: "image record" });
});

test("a task that changed meanwhile is not overwritten", async () => {
  await expect(
    reverifyTaskImages(
      store,
      task,
      deps({ gates: async () => ({ ...passed, images: recorded }), save: async () => false }),
    ),
  ).rejects.toThrow("Task changed");
});
