import { afterEach, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { LocalArtifactStore, verifiedArtifactReadStream } from "../src/artifacts.js";
import type { ArtifactRef, AuthoredTask } from "../src/contracts.js";
import { withTaskBundle } from "../src/generation/activity-runtime.js";
import { runCommand } from "../src/process.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "selfbench-stream-test-"));
  roots.push(root);
  const source = join(root, "source");
  await mkdir(join(source, "harbor-task"), { recursive: true });
  const bytes = Buffer.from("unchanged test and patch contents\n");
  await writeFile(join(source, "harbor-task", "payload"), bytes);
  await runCommand("tar", ["-czf", join(root, "bundle.tgz"), "-C", source, "harbor-task"]);
  const store = new LocalArtifactStore(join(root, "artifacts"));
  const bundle = await store.putFile("bundle.tgz", join(root, "bundle.tgz"), "application/gzip");
  const definition = await store.put(
    "definition.json",
    Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        difficulty: "easy",
        taskId: "stream-test",
        repo: "example/repo",
        baseCommit: "a".repeat(40),
        workdir: ".",
        testCommand: "test {tests}",
        failToPass: ["test"],
        passToPass: [],
        testPaths: ["test"],
        sourcePr: 1,
        sourceUrl: "https://github.com/example/repo/pull/1",
        prompt: "Implement behavior.",
        timeouts: { setupSeconds: 60, agentSeconds: 60, testsSeconds: 60 },
        resources: { cpus: 1, memoryMb: 1024, storageMb: 1024 },
        environment: {
          schemaVersion: 1,
          baseImage: `node:22@sha256:${"a".repeat(64)}`,
          rootSetupCommand: "true",
          setupCommand: "true",
          smokeCommand: "true",
          environmentVariables: {},
          services: [],
          source: "ci-adapted",
          evidence: [{ path: "package.json", reason: "Test command" }],
        },
      }),
    ),
    "application/json",
  );
  const task: AuthoredTask = {
    candidateId: "candidate",
    taskId: "stream-test",
    bundle,
    definition,
    sourceBundle: bundle,
  };
  const get = store.get.bind(store);
  store.get = (ref: ArtifactRef) => {
    if (ref.uri === bundle.uri) throw new Error("bundle must not be buffered");
    return get(ref);
  };
  return { store, task, bytes, archive: await readFile(join(root, "bundle.tgz")) };
}

test("streamed task bytes are identical and concurrent attempts have isolated cleaned directories", async () => {
  const { store, task, bytes } = await fixture();
  const directories = new Set<string>();
  await Promise.all(
    Array.from({ length: 8 }, () =>
      withTaskBundle(store, task, async (path, root) => {
        directories.add(root);
        expect(await readFile(join(path, "payload"))).toEqual(bytes);
      }),
    ),
  );
  expect(directories.size).toBe(8);
  for (const path of directories) await expect(access(path)).rejects.toThrow();
});

for (const failure of ["corrupt", "truncated", "interrupted", "cancelled"] as const) {
  test(`does not run evaluation after a ${failure} transfer`, async () => {
    const { store, task, archive } = await fixture();
    const abort = new AbortController();
    let called = false;
    let closed = false;
    store.openRead = async (ref) =>
      verifiedArtifactReadStream(
        ref,
        Readable.from(
          (async function* () {
            try {
              const bytes = Buffer.from(archive);
              if (failure === "corrupt") bytes.writeUInt8(bytes.readUInt8(0) ^ 1, 0);
              yield failure === "truncated" ? bytes.subarray(0, bytes.length - 1) : bytes;
              if (failure === "interrupted") throw new Error("transfer interrupted");
              if (failure === "cancelled") abort.abort(new Error("cancelled"));
            } finally {
              closed = true;
            }
          })(),
        ),
      );
    await expect(
      withTaskBundle(
        store,
        task,
        async () => {
          called = true;
        },
        abort.signal,
      ),
    ).rejects.toThrow();
    expect(called).toBe(false);
    expect(closed).toBe(true);
  });
}
