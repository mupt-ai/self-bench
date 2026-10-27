import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSnapshotRoute } from "../../src/api/routes/snapshots.js";
import { LocalArtifactStore } from "../../src/artifacts/local.js";
import { fetchSnapshotInBuild } from "../../src/generation/pipeline/remote-gate.js";
import { runCommand } from "../../src/lib/process.js";
import { signSandboxGrant } from "../../src/sandbox/callback-grant.js";
import { GATE_TASK_FILE, SNAPSHOT_FILE, splitGateBundle } from "../../src/sandbox/gate-bundle.js";
import { readSnapshotLink, snapshotLinkUrl } from "../../src/sandbox/snapshot-link.js";

const secret = "s".repeat(32);
const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "selfbench-remote-gate-"));
  roots.push(root);
  return root;
}

async function snapshotApi(store: LocalArtifactStore): Promise<string> {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (!(await handleSnapshotRoute(request, url, response, { secret, store }))) {
      response.writeHead(418).end();
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("a snapshot link is stable, and only its own signature opens it", () => {
  const link = { key: "runs/r/verify/c/compile/attempt-1/repo.tar.gz", sha256: "a".repeat(64) };
  const url = snapshotLinkUrl("https://app.example.dev", link, secret);
  expect(snapshotLinkUrl("https://app.example.dev", link, secret)).toBe(url);
  const path = new URL(url).pathname;
  expect(readSnapshotLink(path, secret)).toEqual(link);
  expect(readSnapshotLink(path, "t".repeat(32))).toBeUndefined();
  expect(readSnapshotLink(`${path.slice(0, -2)}xx`, secret)).toBeUndefined();
  // A sandbox grant signed with the same secret is not a snapshot link.
  const grant = signSandboxGrant(
    {
      taskToken: "dA==",
      prefix: "runs/r",
      sandbox: { sandboxId: "s", stage: "x", startedAt: "t", expiresAt: "t" },
      expiresAt: Date.now() + 60_000,
    },
    secret,
  );
  expect(readSnapshotLink(`/api/snapshots/${grant}`, secret)).toBeUndefined();
});

test("the snapshot route serves the pinned snapshot and nothing else", async () => {
  const store = new LocalArtifactStore(join(await temporary(), "store"));
  const key = "runs/r/verify/c/compile/attempt-1/repo.tar.gz";
  const ref = await store.put(key, Buffer.from("snapshot bytes"), "application/gzip");
  const base = await snapshotApi(store);

  const served = await fetch(snapshotLinkUrl(base, { key, sha256: ref.sha256 }, secret));
  expect(served.status).toBe(200);
  expect(await served.text()).toBe("snapshot bytes");
  const stale = await fetch(snapshotLinkUrl(base, { key, sha256: "0".repeat(64) }, secret));
  expect(stale.status).toBe(404);
  const forged = await fetch(snapshotLinkUrl(base, { key, sha256: ref.sha256 }, "t".repeat(32)));
  expect(forged.status).toBe(404);
});

test("the compiler splits the task from its repository snapshot", async () => {
  const work = await temporary();
  const task = join(work, "src/harbor-task");
  await mkdir(join(task, "environment"), { recursive: true });
  await mkdir(join(task, "tests"), { recursive: true });
  await writeFile(join(task, "environment/Dockerfile"), "FROM scratch\n");
  await writeFile(join(task, "environment/repo.tar.gz"), "snapshot");
  await writeFile(join(task, "tests/repo.tar.gz"), "snapshot");
  await writeFile(join(task, "tests/test.sh"), "exit 0\n");
  const compiled = join(work, "compiled.tar.gz");
  await runCommand("tar", ["-czf", compiled, "-C", join(work, "src"), "harbor-task"]);

  await splitGateBundle(compiled, work);

  expect(await readFile(join(work, SNAPSHOT_FILE), "utf8")).toBe("snapshot");
  const unpacked = join(work, "unpacked");
  await mkdir(unpacked);
  await runCommand("tar", ["-xzf", join(work, GATE_TASK_FILE), "-C", unpacked]);
  expect((await readdir(join(unpacked, "harbor-task"), { recursive: true })).sort()).toEqual([
    "environment",
    "environment/Dockerfile",
    "tests",
    "tests/test.sh",
  ]);

  // A task with services splits the same way: its images are built before its checks too.
  const composed = await temporary();
  await writeFile(join(task, "tests/docker-compose.yaml"), "services: {}\n");
  await runCommand("tar", ["-czf", compiled, "-C", join(work, "src"), "harbor-task"]);
  await splitGateBundle(compiled, composed);
  expect((await readdir(composed)).sort()).toEqual(
    [GATE_TASK_FILE, "gate", SNAPSHOT_FILE, "snapshot"].sort(),
  );
});

test("both gate images fetch the snapshot by digest instead of copying it", async () => {
  const task = await temporary();
  const dockerfile = "FROM base\nCOPY repo.tar.gz /tmp/repo.tar.gz\nRUN tar -xzf x\n";
  for (const context of ["environment", "tests"]) {
    await mkdir(join(task, context));
    await writeFile(join(task, context, "Dockerfile"), dockerfile);
  }
  const remote = {
    bundle: ref("gate"),
    snapshotUrl: "https://api/s/abc.def",
    snapshotSha256: "f0",
  };

  await fetchSnapshotInBuild(task, remote);

  for (const context of ["environment", "tests"]) {
    expect(await readFile(join(task, context, "Dockerfile"), "utf8")).toBe(
      "FROM base\nADD --checksum=sha256:f0 https://api/s/abc.def /tmp/repo.tar.gz\nRUN tar -xzf x\n",
    );
  }
  await expect(fetchSnapshotInBuild(task, remote)).rejects.toThrow("snapshot");
});

function ref(name: string) {
  return {
    uri: `gs://b/${name}`,
    sha256: `${name}-sha`,
    sizeBytes: 1,
    contentType: "application/gzip",
  };
}
