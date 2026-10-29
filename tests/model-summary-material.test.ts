import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../src/artifacts/local.js";
import { summarizable } from "../src/evaluation/model-summary.js";
import { summaryMaterial } from "../src/evaluation/model-summary-material.js";
import { initialEvaluation } from "../src/evaluation/store.js";
import type { EvaluationInput, EvaluationTrial } from "../src/evaluation/types.js";
import { profileLines, profileText } from "../src/public/model-profile.js";
import { evaluationInput } from "./support/evaluation-fixture.js";
import { gzippedTar } from "./support/tar.js";

const credentials = {
  modelCredentialId: "model-key",
  sandboxCredentialId: "sandbox-key",
  provider: "openai" as const,
};

/** A completed run of `model` on harness `codex`, each task's trial as `trials` says. */
function run(model: string, trials: Record<string, Partial<EvaluationTrial>>) {
  const input: EvaluationInput = {
    ...evaluationInput(),
    model,
    modelName: `openai/${model}`,
    thinking: "high",
    credentials,
    tasks: Object.keys(trials).map((taskId) => ({
      runId: "run-one",
      taskId,
      bundleKey: `tasks/${taskId}.tar.gz`,
    })),
  };
  const evaluation = initialEvaluation(input, model);
  for (const trial of evaluation.trials)
    Object.assign(trial, {
      status: "completed",
      modelVerified: true,
      apiCostUsd: 0.2,
      startedAt: "2026-10-28T10:00:00.000Z",
      finishedAt: "2026-10-28T10:12:00.000Z",
      ...trials[trial.taskId],
    });
  return evaluation;
}

const pass = { rewards: { reward: 1 } };
const fail = (rewards: Record<string, number> = {}, extra: Partial<EvaluationTrial> = {}) => ({
  rewards: { reward: 0, ...rewards },
  ...extra,
});

test("the material gives each configuration its rates by difficulty and change size and its time-outs, and leaves shared failures out of its evidence", async () => {
  const store = new LocalArtifactStore(await mkdtemp(join(tmpdir(), "selfbench-material-")));
  const patch = (files: number, lines: number) =>
    Array.from({ length: files }, (_, file) =>
      [
        `diff --git a/f${file} b/f${file}`,
        `--- a/f${file}`,
        `+++ b/f${file}`,
        ...Array.from({ length: Math.ceil(lines / files) }, () => "+line"),
      ].join("\n"),
    ).join("\n");
  const shapes = { tiny: [1, 10], wide: [8, 300], everyone: [3, 60] } as const;
  for (const [taskId, [files, lines]] of Object.entries(shapes))
    await store.put(
      `tasks/${taskId}.tar.gz`,
      await gzippedTar({
        "instruction.md": `Do ${taskId}.`,
        "solution/gold.patch": patch(files, lines),
      }),
      "application/gzip",
    );
  const runs = [
    run("alpha", {
      tiny: pass,
      wide: fail({ pass_to_pass: 0, fail_to_pass: 1 }),
      everyone: fail({}, { agentTimedOut: true }),
    }),
    run("beta", { tiny: pass, wide: pass, everyone: fail({ fail_to_pass: 0 }) }),
    run("gamma", { tiny: fail({ patch_applied: 0 }), wide: pass, everyone: fail() }),
  ];
  const tasks = [
    { runId: "run-one", taskId: "tiny", bundleKey: "tasks/tiny.tar.gz", difficulty: "easy" },
    { runId: "run-one", taskId: "wide", bundleKey: "tasks/wide.tar.gz", difficulty: "hard" },
    {
      runId: "run-one",
      taskId: "everyone",
      bundleKey: "tasks/everyone.tar.gz",
      difficulty: "medium",
    },
  ];
  const settings = summarizable(runs, tasks);
  const material = await summaryMaterial(store, { repoId: 1 }, tasks, [...settings.values()]);
  expect(material).toContain(
    '<configuration label="C1" passed="1/3" by_difficulty="easy 1/1, medium 0/1, hard 0/1" by_change_size="small 1/1, medium 0/1, large 0/1" ran_out_of_time="1">alpha · high reasoning · Codex</configuration>',
  );
  expect(material).toContain(
    '<task id="wide" difficulty="hard" reference_change="8 files, 304 lines" outcomes="C1 failed, C2 passed, C3 passed">Do wide.</task>',
  );
  // Every configuration failed it: marked, and never anyone's evidence.
  expect(material).toContain(
    'id="everyone" difficulty="medium" reference_change="3 files, 60 lines" shared_failure="true"',
  );
  expect(material).not.toContain('<failed_task id="everyone"');
  // How each failure went, from its checks.
  expect(material).toContain('<failed_task id="wide" how="broke existing behavior">');
  expect(material).toContain('<failed_task id="tiny" how="its change did not apply">');
});

test("a routing profile is read off however the model formatted its labels", () => {
  const written =
    "**Send it:** Small bug fixes.\n- Avoid or review: Large migrations;\n  check the callers.\nHow it fails: Stops early.";
  expect(profileText(written)).toBe(
    "Send it: Small bug fixes.\nAvoid or review: Large migrations; check the callers.\nHow it fails: Stops early.",
  );
  expect(profileLines(profileText(written))?.map((line) => line.label)).toEqual([
    "Send it",
    "Avoid or review",
    "How it fails",
  ]);
  // A summary from before profiles stays a paragraph.
  expect(profileLines("It handles focused fixes well.")).toBeUndefined();
  expect(profileText(" It handles focused fixes well. ")).toBe("It handles focused fixes well.");
});
