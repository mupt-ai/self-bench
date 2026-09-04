import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../src/artifacts.js";
import { runCommand } from "../src/process.js";
import {
  archivedCandidates,
  clearArchivedListingCache,
  listArchivedRuns,
} from "../src/viewer/archived.js";
import { candidateArtifacts } from "../src/viewer/artifacts.js";
import { clearBundleCache, expandBundle } from "../src/viewer/bundle.js";
import {
  candidateStage,
  listCandidates,
  reasonSummary,
  testRunner,
} from "../src/viewer/candidates.js";
import { startViewServer } from "../src/viewer/local-server.js";
import {
  readTaskDirectory,
  resolveTaskDirectory,
  scanHarborTasks,
} from "../src/viewer/task-files.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  await clearBundleCache();
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

describe("candidate classification", () => {
  test("derives the pipeline stage from status and reason", () => {
    expect(candidateStage({ status: "accepted" })).toBe("accepted");
    expect(candidateStage({ status: "infrastructure_failed" })).toBe("infrastructure");
    expect(candidateStage({ status: "verifying" })).toBe("in_progress");
    expect(
      candidateStage({ status: "rejected", reason: "authoring tests never fail; log: gs://x" }),
    ).toBe("authoring");
    expect(
      candidateStage({ status: "rejected", reason: "verifier tests are coupled; log: gs://x" }),
    ).toBe("review");
    expect(
      candidateStage({ status: "rejected", reason: "hard mode requires at least 3 files" }),
    ).toBe("audit");
    expect(
      candidateStage({
        status: "rejected",
        reason: "validation repair failed after its single activity attempt",
      }),
    ).toBe("validation");
    expect(candidateStage({ status: "rejected", reason: "test repair failed" })).toBe("review");
    expect(
      candidateStage({ status: "rejected", reason: "environment authoring failed in sb-1" }),
    ).toBe("environment");
    expect(candidateStage({ status: "rejected", reason: "pytest ... FAILED" })).toBe("preflight");
  });

  test("names the test runner and summarizes noisy reasons", () => {
    expect(testRunner("pnpm --filter=@posthog/frontend jest {tests}")).toBe("jest");
    expect(testRunner("pytest -c pytest.ini {tests}")).toBe("pytest");
    expect(testRunner("bin/hogli test {tests}")).toBe("hogli");
    expect(testRunner("cargo test -p thing {tests}")).toBe("cargo");
    expect(
      reasonSummary("[truncated 12 bytes]\n\n  WARN noise\nError: SECRET_KEY looks like a secret"),
    ).toBe("Error: SECRET_KEY looks like a secret");
    expect(reasonSummary(undefined)).toBeUndefined();
  });
});

describe("artifact store listing", () => {
  test("lists keys under a prefix and joins candidate definitions", async () => {
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

    const listed = await store.list("runs/run-1/audits/task-a");
    expect(listed.map((entry) => entry.key)).toEqual(["runs/run-1/audits/task-a/abc.json"]);
    expect(await store.list("runs/run-1/missing")).toEqual([]);

    const candidates = await listCandidates(store, {
      runId: "run-1",
      phase: "complete",
      requested: 1,
      requestedByDifficulty: { easy: 0, medium: 1, hard: 0 },
      discovered: 1,
      accepted: 1,
      rejected: 0,
      tasks: [
        { taskId: "task-a", candidateId: "cand-a", difficulty: "medium", status: "accepted" },
      ],
    });
    expect(candidates.candidates[0]?.definition?.runner).toBe("jest");
    expect(candidates.candidates[0]?.definition?.passToPass).toBe(2);

    const artifacts = await candidateArtifacts(store, "run-1", {
      taskId: "task-a",
      candidateId: "cand-a",
    });
    expect(artifacts.groups.audits).toHaveLength(1);
    expect(artifacts.groups.provenance.map((entry) => entry.key)).toEqual([
      "runs/run-1/provenance/cand-a.json",
    ]);

    const archived = await archivedCandidates(store, "run-1");
    expect(archived.candidates[0]?.taskId).toBe("task-a");
    expect(archived.candidates[0]?.stage).toBe("audit");
    expect(archived.candidates[0]?.status).toBe("archived");
    await store.put(
      "runs/run-1/reviews/task-a/abc/attempt-1.json",
      Buffer.from('{"verdict":"clean"}'),
      "application/json",
    );
    clearArchivedListingCache();
    const reviewed = await archivedCandidates(store, "run-1");
    expect(reviewed.candidates[0]?.status).toBe("accepted");
    expect(reviewed.candidates[0]?.stage).toBe("accepted");
    expect((await listArchivedRuns(store)).map((run) => run.runId)).toEqual(["run-1"]);

    // Stage is the furthest group that wrote anything: a lone definition is still "authoring",
    // and legacy verify checkpoints (keyed by candidate ID) count as authored too.
    await store.put(
      "runs/run-1/authoring/cand-b/definition.json",
      Buffer.from(JSON.stringify({ ...definition, taskId: "task-b" })),
      "application/json",
    );
    await store.put(
      "runs/run-1/verify/cand-c/attempt-1/modal.log",
      Buffer.from("log"),
      "text/plain",
    );
    await store.put(
      "runs/run-2/authoring/cand-d/attempt-1/modal.log",
      Buffer.from("log"),
      "text/plain",
    );
    // The run index is cached alongside the per-run listings until it is cleared.
    expect((await listArchivedRuns(store)).map((run) => run.runId)).toEqual(["run-1"]);
    clearArchivedListingCache();
    // Newest run first: run-2 was written after every run-1 object.
    expect((await listArchivedRuns(store)).map((run) => run.runId)).toEqual(["run-2", "run-1"]);
    const stages = new Map(
      (await archivedCandidates(store, "run-1")).candidates.map((candidate) => [
        candidate.candidateId,
        candidate,
      ]),
    );
    expect(stages.get("cand-a")?.stage).toBe("accepted");
    expect(stages.get("cand-b")?.stage).toBe("authoring");
    expect(stages.get("cand-b")?.taskId).toBe("task-b");
    expect(stages.get("cand-c")?.stage).toBe("authoring");
    expect(stages.get("cand-c")?.taskId).toBe("cand-c");

    // Agent-pipeline runs decide candidates in round results, not coupling reviews: the latest
    // verification round's accepted result.json is the accept signal, and a rejected round result
    // names the loop that ended the candidate.
    await store.put(
      "runs/run-1/verification/cand-b/round-1/result.json",
      Buffer.from(JSON.stringify({ kind: "fixed", candidateId: "cand-b" })),
      "application/json",
    );
    await store.put(
      "runs/run-1/verification/cand-b/round-2/result.json",
      Buffer.from(JSON.stringify({ kind: "accepted", reason: "held-out tests pin the fix" })),
      "application/json",
    );
    await store.put(
      "runs/run-1/authoring/cand-c/round-3/result.json",
      Buffer.from(
        JSON.stringify({ kind: "rejected", reason: "authoring tests never fail; log: gs://x" }),
      ),
      "application/json",
    );
    clearArchivedListingCache();
    const decided = new Map(
      (await archivedCandidates(store, "run-1")).candidates.map((candidate) => [
        candidate.candidateId,
        candidate,
      ]),
    );
    expect(decided.get("cand-b")?.status).toBe("accepted");
    expect(decided.get("cand-b")?.stage).toBe("accepted");
    expect(decided.get("cand-b")?.reasonSummary).toContain("held-out tests pin the fix");
    expect(decided.get("cand-c")?.status).toBe("archived");
    expect(decided.get("cand-c")?.stage).toBe("authoring");
    expect(decided.get("cand-c")?.reasonSummary).toContain("authoring tests never fail");
  });
});

describe("harbor task directories and bundles", () => {
  test("scans, reads, and guards task directories", async () => {
    const root = await temporaryRoot();
    await writeHarborTask(join(root, "alpha"), "selfbench/alpha");
    await writeHarborTask(join(root, "nested/beta/harbor-task"), "selfbench/beta");
    const tasks = await scanHarborTasks(root);
    expect(tasks.map((task) => task.taskId)).toEqual(["alpha", "nested/beta"]);
    expect(tasks[0]?.name).toBe("selfbench/alpha");
    expect(tasks[0]?.difficulty).toBe("medium");

    const files = await readTaskDirectory(resolveTaskDirectory(root, "alpha"), "alpha");
    const byPath = new Map(files.files.map((file) => [file.path, file]));
    expect(byPath.get("instruction.md")?.text).toBe("Do the thing.\n");
    expect(byPath.get("environment/repo.tar.gz")?.text).toBeUndefined();
    expect(() => resolveTaskDirectory(root, "../etc")).toThrow();
  });

  test("expands a stored bundle once and serves it from the cache", async () => {
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

  test("serves a local directory over HTTP", async () => {
    const root = await temporaryRoot();
    await writeHarborTask(join(root, "delta"), "selfbench/delta");
    const server = await startViewServer({ root, host: "127.0.0.1", port: 0 });
    try {
      const info = (await (await fetch(`${server.url}/v1/viewer`)).json()) as { modes: string[] };
      expect(info.modes).toEqual(["local"]);
      const tasks = (await (await fetch(`${server.url}/v1/local/tasks`)).json()) as {
        taskId: string;
      }[];
      expect(tasks.map((task) => task.taskId)).toEqual(["delta"]);
      const files = (await (await fetch(`${server.url}/v1/local/task?id=delta`)).json()) as {
        files: { path: string }[];
      };
      expect(files.files.map((file) => file.path)).toContain("environment/Dockerfile");
      expect((await fetch(`${server.url}/v1/local/task?id=../x`)).status).toBe(400);
    } finally {
      await server.stop();
    }
  });
});
