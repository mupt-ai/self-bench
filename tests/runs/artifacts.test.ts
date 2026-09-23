import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../../src/artifacts/index.js";
import {
  archivedCandidates,
  clearArchivedListingCache,
  listArchivedRuns,
} from "../../src/generation/runs/archived.js";
import { candidateArtifacts } from "../../src/generation/runs/artifacts.js";
import { clearBundleCache, expandBundle } from "../../src/generation/runs/bundle.js";
import { reasonSummary, testRunner } from "../../src/generation/runs/candidate-summary.js";
import { readTaskDirectory } from "../../src/generation/runs/task-files.js";
import { runCommand } from "../../src/lib/process.js";

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

    const listed = await store.list("runs/run-1/audits/task-a");
    expect(listed.map((entry) => entry.key)).toEqual(["runs/run-1/audits/task-a/abc.json"]);
    expect(await store.list("runs/run-1/missing")).toEqual([]);

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
    // Stage is the furthest group that wrote anything: a lone definition is still "authoring".
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
    // Newest run first: run-2 was written after every run-1 object.
    expect((await listArchivedRuns(store)).map((run) => run.runId)).toEqual(["run-2", "run-1"]);
    clearArchivedListingCache();
    const stages = new Map(
      (await archivedCandidates(store, "run-1")).candidates.map((candidate) => [
        candidate.candidateId,
        candidate,
      ]),
    );
    expect(stages.get("cand-a")?.stage).toBe("audit");
    expect(stages.get("cand-b")?.stage).toBe("authoring");
    expect(stages.get("cand-b")?.taskId).toBe("task-b");
    expect(stages.get("cand-c")?.stage).toBe("authoring");
    expect(stages.get("cand-c")?.taskId).toBe("cand-c");

    // Agent-pipeline runs decide candidates in round results, not coupling reviews: the latest
    // review round's accepted result.json is the accept signal, and a rejected round result
    // names the loop that ended the candidate.
    await store.put(
      "runs/run-1/verification/cand-b/round-1/result.json",
      Buffer.from(
        JSON.stringify({ kind: "suggestions", summary: "legacy", suggestions: "ignored" }),
      ),
      "application/json",
    );
    await store.put(
      "runs/run-1/verification/cand-b/round-2/result.json",
      Buffer.from(JSON.stringify({ kind: "accepted", reason: "held-out tests pin the fix" })),
      "application/json",
    );
    await store.put(
      "runs/run-1/verification/cand-c/round-2/result.json",
      Buffer.from(
        JSON.stringify({
          kind: "suggestions",
          summary: "Revise tests",
          suggestions: "Use a public seam",
        }),
      ),
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
  test("reads task directories", async () => {
    const root = await temporaryRoot();
    await writeHarborTask(join(root, "alpha"), "selfbench/alpha");
    const files = await readTaskDirectory(join(root, "alpha"), "alpha");
    const byPath = new Map(files.files.map((file) => [file.path, file]));
    expect(byPath.get("instruction.md")?.text).toBe("Do the thing.\n");
    expect(byPath.get("environment/repo.tar.gz")?.text).toBeUndefined();
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
});
