import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../src/artifacts/index.js";
import { type HarborLiveSnapshot, harborLiveFeed } from "../src/generation/pipeline/harbor-live.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("publishes Harbor milestones and output as redacted, immutable snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "selfbench-harbor-live-"));
  roots.push(root);
  const store = new LocalArtifactStore(join(root, "store"));
  const trial = join(root, "jobs", "job-1", "trial-1");
  await mkdir(trial, { recursive: true });
  await writeFile(join(trial, "trial.log"), "Selected strategy: _ModalDirect\nBuilding image\n");
  // Sandbox downloads land deeper in the trial and may reuse the name; they are not milestones.
  await mkdir(join(trial, "verifier"));
  await writeFile(join(trial, "verifier", "trial.log"), "planted by the task\n");
  // Another run's job in the same jobs directory must not leak into this run's snapshots.
  await mkdir(join(root, "jobs", "job-0", "trial-0"), { recursive: true });
  await writeFile(join(root, "jobs", "job-0", "trial-0", "trial.log"), "nop finished\n");
  const prefix = "runs/run-1/verify/candidate/authoring-round-1-turn-1";
  const feed = harborLiveFeed(store, prefix, "nop", join(root, "jobs", "job-1"), {
    attempt: 2,
    secrets: ["as-secret-token"],
  });
  feed.push("stdout", Buffer.from("token as-secret-token in output\n"));
  await feed.close();

  const keys = (await store.list(`${prefix}/live`)).map((entry) => entry.key);
  expect(keys).toEqual([`${prefix}/live/02-nop-000000.json`]);
  const snapshot = JSON.parse(
    Buffer.from((await store.getByKey(keys[0] ?? "")) ?? new Uint8Array()).toString("utf8"),
  ) as HarborLiveSnapshot;
  expect(snapshot.run).toBe("nop");
  expect(snapshot.steps).toEqual(["Selected strategy: _ModalDirect", "Building image"]);
  expect(snapshot.output).toBe("token [redacted] in output\n");
  expect(Date.parse(snapshot.capturedAt)).toBeGreaterThanOrEqual(Date.parse(snapshot.startedAt));
});
