import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  guardHarborOutput,
  HarborOutputLimitError,
  readBoundedText,
} from "../../src/harnesses/harbor/output-guard.js";
import { readHarborJobResult } from "../../src/harnesses/harbor/results.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "selfbench-output-guard-"));
  roots.push(root);
  return root;
}

test("bounded reads keep small files whole and the ends of large ones", async () => {
  const root = await scratch();
  await writeFile(join(root, "small.txt"), "hello\n");
  await writeFile(join(root, "large.txt"), `START${"x".repeat(10_000)}END`);
  expect(await readBoundedText(join(root, "small.txt"), 100)).toBe("hello\n");
  const large = await readBoundedText(join(root, "large.txt"), 100);
  expect(large?.startsWith("STARTx")).toBe(true);
  expect(large?.endsWith("xEND")).toBe(true);
  expect(large).toContain("bytes omitted");
  expect(large?.length).toBeLessThan(200);
  expect(await readBoundedText(join(root, "missing.txt"))).toBeUndefined();
});

test("bounded reads refuse links a sandbox download could plant", async () => {
  const root = await scratch();
  await writeFile(join(root, "secret"), "worker file\n");
  await symlink(join(root, "secret"), join(root, "test-stdout.txt"));
  await expect(readBoundedText(join(root, "test-stdout.txt"))).rejects.toThrow();
});

/** Stands in for the Harbor process: settles when the guard's signal aborts it. */
function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((_resolve, reject) =>
    signal.addEventListener("abort", () => reject(signal.reason)),
  );
}

test("the guard aborts once Harbor's directories pass the limit", async () => {
  const root = await scratch();
  const parent = new AbortController();
  const guard = guardHarborOutput([join(root, "jobs"), join(root, "missing")], parent.signal, {
    limitBytes: 1_000,
    intervalMs: 5,
  });
  await mkdir(join(root, "jobs", "trial", "verifier"), { recursive: true });
  await writeFile(join(root, "jobs", "trial", "verifier", "test-stdout.txt"), "x".repeat(2_000));
  await expect(guard.watch(untilAborted(guard.signal))).rejects.toBeInstanceOf(
    HarborOutputLimitError,
  );
  expect(parent.signal.aborted).toBe(false);
});

test("the guard also counts files, and a run that ends past the limit still fails", async () => {
  const root = await scratch();
  const guard = guardHarborOutput([root], undefined, { limitEntries: 3, intervalMs: 5 });
  await Promise.all([1, 2, 3, 4].map((index) => writeFile(join(root, `${index}`), "")));
  const finished = new Promise<string>((resolve) =>
    guard.signal.addEventListener("abort", () => resolve("exited 0")),
  );
  await expect(guard.watch(finished)).rejects.toBeInstanceOf(HarborOutputLimitError);
});

test("a run that finishes before the next poll is still measured", async () => {
  const root = await scratch();
  const guard = guardHarborOutput([root], undefined, { limitBytes: 1_000, intervalMs: 60_000 });
  await writeFile(join(root, "burst"), "x".repeat(2_000));
  await expect(guard.watch(Promise.resolve("exited 0"))).rejects.toBeInstanceOf(
    HarborOutputLimitError,
  );
});

test("the guard passes through its parent's cancellation and a clean run's result", async () => {
  const root = await scratch();
  const parent = new AbortController();
  const cancelled = guardHarborOutput([root], parent.signal, { intervalMs: 5 });
  const harbor = cancelled.watch(untilAborted(cancelled.signal));
  parent.abort(new Error("activity cancelled"));
  await expect(harbor).rejects.toThrow("activity cancelled");
  const clean = guardHarborOutput([root], undefined, { intervalMs: 5 });
  expect(await clean.watch(Promise.resolve("done"))).toBe("done");
});

test("verifier output is read bounded and an oversized trial result is refused", async () => {
  const root = await scratch();
  const trial = join(root, "job", "trial-1");
  await mkdir(join(trial, "verifier"), { recursive: true });
  await writeFile(join(root, "job", "result.json"), "{}");
  await writeFile(join(trial, "result.json"), "{}");
  await writeFile(join(trial, "verifier", "test-stdout.txt"), "y".repeat(5 * 1024 * 1024));
  const result = await readHarborJobResult(root, "job");
  expect(result.verifier?.combined?.length).toBeLessThan(3 * 1024 * 1024);

  await writeFile(join(trial, "result.json"), `{"pad":"${"z".repeat(17 * 1024 * 1024)}"}`);
  await expect(readHarborJobResult(root, "job")).rejects.toThrow(
    new HarborOutputLimitError(`Harbor result ${join(trial, "result.json")} is larger than 16 MiB`),
  );
});
