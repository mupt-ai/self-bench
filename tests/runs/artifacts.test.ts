import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../../src/artifacts/index.js";
import { listArchivedRuns } from "../../src/generation/runs/archived.js";
import { candidateArtifacts } from "../../src/generation/runs/artifacts.js";
import { expandBundle } from "../../src/generation/runs/bundle.js";
import { readTaskDirectory } from "../../src/generation/runs/task-files.js";
import { runCommand } from "../../src/lib/process.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "selfbench-viewer-"));
  roots.push(root);
  return root;
}

async function writeHarborTask(directory: string, name: string): Promise<void> {
  await mkdir(join(directory, "environment"), { recursive: true });
  await mkdir(join(directory, "tests"), { recursive: true });
  await writeFile(
    join(directory, "task.toml"),
    `[task]\nname = "${name}"\n\n[metadata]\ndifficulty = "medium"\n`,
  );
  await writeFile(join(directory, "instruction.md"), "Do the thing.\n");
  await writeFile(join(directory, "environment/Dockerfile"), "FROM scratch\n");
  await writeFile(join(directory, "environment/repo.tar.gz"), Buffer.from([0x1f, 0x8b, 0, 0]));
  await writeFile(join(directory, "tests/test.patch"), "diff --git a/x b/x\n");
}

describe("artifact store listing", () => {
  test("lists keys under a prefix and groups candidate artifacts", async () => {
    const root = await temporaryRoot();
    const store = new LocalArtifactStore(root);
    const definition = {
      taskId: "task-a",
      difficulty: "medium",
      testCommand: "pnpm jest {tests}",
      failToPass: ["a"],
      passToPass: ["b", "c"],
      testPaths: ["a", "b"],
      workdir: ".",
      sourcePr: 7,
      sourceUrl: "https://github.com/o/r/pull/7",
      baseCommit: "a".repeat(40),
    };
    await store.put(
      "runs/run-1/authoring/cand-a/definition.json",
      Buffer.from(JSON.stringify(definition)),
      "application/json",
    );
    await store.put(
      "runs/run-1/audits/task-a/abc.json",
      Buffer.from('{"accepted":true}'),
      "application/json",
    );
    await store.put("runs/run-1/provenance/cand-a.json", Buffer.from("{}"), "application/json");
    const record = {
      stage: "authoring" as const,
      round: 1,
      turn: 2,
      attempt: 1,
      prefix: "runs/run-1/authoring/cand-a/round-1/turn-2/attempt-1",
      startedAt: "2026-09-23T10:00:00Z",
    };
    await store.put(
      `${record.prefix}/agent.json`,
      Buffer.from(JSON.stringify(record)),
      "application/json",
    );
    const finished = {
      ...record,
      turn: 1,
      prefix: "runs/run-1/authoring/cand-a/round-1/turn-1/attempt-1",
      startedAt: "2026-09-23T09:00:00Z",
    };
    await store.put(
      `${finished.prefix}/agent.json`,
      Buffer.from(JSON.stringify(finished)),
      "application/json",
    );
    await store.put(
      `${finished.prefix}/result.json`,
      Buffer.from(JSON.stringify({ finishedAt: "2026-09-23T09:30:00Z", exitCode: 0 })),
      "application/json",
    );

    const listed = await store.list("runs/run-1/audits/task-a");
    expect(listed.map((entry) => entry.key)).toEqual(["runs/run-1/audits/task-a/abc.json"]);
    expect(await store.list("runs/run-1/missing")).toEqual([]);

    const artifacts = await candidateArtifacts(store, "run-1", {
      taskId: "task-a",
      candidateId: "cand-a",
    });
    expect(artifacts.groups.audits).toHaveLength(1);
    expect(artifacts.agents).toEqual([
      { ...finished, finishedAt: "2026-09-23T09:30:00Z", exitCode: 0 },
      record,
    ]);
    expect(artifacts.groups.provenance.map((entry) => entry.key)).toEqual([
      "runs/run-1/provenance/cand-a.json",
    ]);

    await store.put(
      "runs/run-2/authoring/cand-d/attempt-1/modal.log",
      Buffer.from("log"),
      "text/plain",
    );
    // Newest run first: run-2 was written after every run-1 object.
    expect((await listArchivedRuns(store)).map((run) => run.runId)).toEqual(["run-2", "run-1"]);
  });
});

describe("harbor task directories and bundles", () => {
  test("reads task directories", async () => {
    const root = await temporaryRoot();
    await writeHarborTask(join(root, "alpha"), "selfbench/alpha");
    const files = await readTaskDirectory(join(root, "alpha"), "alpha");
    const byPath = new Map(files.files.map((file) => [file.path, file]));
    expect(byPath.get("instruction.md")?.text).toBe("Do the thing.\n");
    expect(byPath.get("environment/repo.tar.gz")?.text).toBeUndefined();
  });

  test("expands a stored bundle on each request", async () => {
    const root = await temporaryRoot();
    const source = join(root, "source");
    await writeHarborTask(join(source, "harbor-task"), "selfbench/gamma");
    const archive = join(root, "bundle.tar.gz");
    await runCommand("tar", ["-czf", archive, "-C", source, "harbor-task"]);
    const store = new LocalArtifactStore(join(root, "store"));
    const key = "runs/run-2/environments/gamma/h/initial/trusted-compiler-v1/harbor-task.tar.gz";
    await store.putFile(key, archive, "application/gzip");

    const first = await expandBundle(store, key);
    expect(first.taskId).toBe("gamma");
    expect(first.files.some((file) => file.path === "task.toml")).toBe(true);
    const second = await expandBundle(store, key);
    expect(second.files.length).toBe(first.files.length);
    await expect(expandBundle(store, "runs/run-2/missing.tar.gz")).rejects.toThrow("not found");
  });
});
