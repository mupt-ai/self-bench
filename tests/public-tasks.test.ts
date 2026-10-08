import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import { sendApiError } from "../src/api/http.js";
import { createPublicReleaseRoutes } from "../src/api/routes/public-releases.js";
import { publishedTasks } from "../src/api/routes/public-tasks.js";
import type { ReleaseTask } from "../src/public/release-rule.js";
import type { PublishedLine } from "../src/public/release-types.js";
import { gzippedTar, tarEntries } from "./support/tar.js";

const TASK = {
  "harbor-task/task.toml": 'name = "selfbench/next-pr-1"\n',
  "harbor-task/instruction.md": "Order the chunks by path.\n",
  "harbor-task/environment/Dockerfile": "FROM rust\nCOPY repo.tar.gz /tmp/\n",
  "harbor-task/solution/gold.patch": "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
  "harbor-task/solution/solve.sh|755": "#!/bin/sh\ngit apply gold.patch\n",
};
const SNAPSHOTS = {
  "harbor-task/environment/repo.tar.gz": "the repository, tens of MB",
  "harbor-task/tests/repo.tar.gz": "the repository again",
};

/** An artifact store over objects in memory, as the routes read it. */
function storeOf(objects: Map<string, Buffer>) {
  return {
    async stat(key: string) {
      const bytes = objects.get(key);
      return bytes
        ? {
            uri: `memory://${key}`,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            sizeBytes: bytes.length,
          }
        : undefined;
    },
    async openReadByKey(key: string) {
      const bytes = objects.get(key);
      return bytes ? Readable.from([bytes]) : undefined;
    },
  };
}

const task = (
  taskId: string,
  bundleKey: string,
  extra: Partial<ReleaseTask> = {},
): ReleaseTask => ({
  key: JSON.stringify(["batch-1", taskId]),
  runId: "batch-1",
  taskId,
  difficulty: "medium",
  sourcePr: 1,
  sourceUrl: "https://github.com/vercel/next.js/pull/1",
  reason: "a private note on why it was accepted",
  bundleKey,
  state: "accepted",
  runnable: true,
  ...extra,
});

const line = (releaseId: string, tasksPublished: boolean): PublishedLine => ({
  release: {
    schemaVersion: 1,
    releaseId,
    releasedAt: "2026-10-01T00:00:00Z",
    repository: { id: 1, fullName: "vercel/next.js" },
    publisher: { login: "mupt-ai", kind: "org" },
    tasks: 2,
    settings: [],
    frontier: [],
    ...(tasksPublished ? { tasksPublished: true as const } : {}),
  },
  endorsed: false,
});

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/**
 * Two current releases, one that published its tasks and one that did not. The published one
 * has a task with a gate task beside its bundle and a task without (as tasks with services are).
 */
async function serve() {
  const withGate = "runs/batch-1/verify/c1/compile/attempt-1/harbor-task.tar.gz";
  const withoutGate = "runs/batch-1/verify/c2/compile/attempt-1/harbor-task.tar.gz";
  const objects = new Map<string, Buffer>([
    [withGate, await gzippedTar({ ...TASK, ...SNAPSHOTS })],
    ["runs/batch-1/verify/c1/compile/attempt-1/gate-task.tar.gz", await gzippedTar(TASK)],
    ["runs/batch-1/verify/c1/compile/attempt-1/repo.tar.gz", Buffer.from("snapshot")],
    [withoutGate, await gzippedTar({ ...TASK, ...SNAPSHOTS })],
  ]);
  const released: Record<string, ReleaseTask[]> = {
    "published-release": [
      task("next-pr-1", withGate),
      task("next-pr-2", withoutGate),
      // An agent may name a task anything its characters allow, a download's suffix included.
      task("odd.tar.gz", withGate),
    ],
    "private-release": [task("next-pr-1", withGate)],
  };
  const routes = createPublicReleaseRoutes(
    {
      currentLines: async () => [line("published-release", true), line("private-release", false)],
      releasedTasks: async (id) => released[id],
    },
    { artifacts: storeOf(objects) },
  );
  const server = createServer(async (request, response) => {
    try {
      await routes.handle(request, new URL(request.url ?? "/", "http://localhost"), response);
    } catch (error) {
      sendApiError(response, error);
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  return (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${address.port}${path}`, init);
}

test("tasks sharing an id are numbered in key order, and nothing private is listed", () => {
  const listed = publishedTasks([
    task("next-pr-1", "b", { key: JSON.stringify(["batch-2", "next-pr-1"]) }),
    task("next-pr-1", "a"),
  ]);
  expect(listed.map(({ task }) => task.id)).toEqual(["next-pr-1", "next-pr-1~2"]);
  expect(listed.map(({ bundleKey }) => bundleKey)).toEqual(["a", "b"]);
  expect(Object.keys(listed[0]?.task ?? {}).sort()).toEqual([
    "difficulty",
    "id",
    "sourcePr",
    "sourceUrl",
  ]);
});

test("only a current release that published its tasks serves them, never to search engines", async () => {
  const get = await serve();
  for (const path of [
    "/api/public/releases/private-release/tasks",
    "/api/public/releases/private-release/tasks/next-pr-1",
    "/api/public/releases/gone-release/tasks",
  ]) {
    const response = await get(path);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
  }
  const list = await get("/api/public/releases/published-release/tasks");
  expect(list.status).toBe(200);
  expect(list.headers.get("cache-control")).toBe("public, max-age=60, s-maxage=60");
  expect(list.headers.get("x-robots-tag")).toBe("noindex");
  const body = await list.text();
  expect(JSON.parse(body).tasks.map((entry: { id: string }) => entry.id)).toEqual([
    "next-pr-1",
    "next-pr-2",
    "odd.tar.gz",
  ]);
  // The row's private fields stay on the server.
  expect(body).not.toContain("bundleKey");
  expect(body).not.toContain("private note");
  expect((await get("/api/public/releases/published-release/tasks/next-pr-9")).status).toBe(404);
});

test("a task's files are its text files and, by size alone, its repository snapshots", async () => {
  const get = await serve();
  const response = await get("/api/public/releases/published-release/tasks/next-pr-1");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("public, max-age=60, s-maxage=60");
  expect(response.headers.get("x-robots-tag")).toBe("noindex");
  const files = (await response.json()) as {
    taskId: string;
    files: { path: string; text?: string }[];
  };
  expect(files.taskId).toBe("next-pr-1");
  expect(files.files.find((file) => file.path === "instruction.md")?.text).toBe(
    "Order the chunks by path.\n",
  );
  const snapshot = files.files.find((file) => file.path === "environment/repo.tar.gz");
  expect(snapshot?.text).toBeUndefined();
  // Read again from the browser's copy: a bodyless 304.
  const again = await get("/api/public/releases/published-release/tasks/next-pr-1", {
    headers: { "if-none-match": response.headers.get("etag") ?? "" },
  });
  expect(again.status).toBe(304);
});

test("a download is the task without its snapshots, in a folder named after it", async () => {
  const get = await serve();
  // From the gate task beside the bundle, and from a bundle with none: the same task.
  for (const id of ["next-pr-1", "next-pr-2"]) {
    const response = await get(`/api/public/releases/published-release/tasks/${id}/${id}.tar.gz`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/gzip");
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="${id}.tar.gz"`);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60, s-maxage=60");
    const found = await tarEntries(Buffer.from(await response.arrayBuffer()));
    expect(found.map((entry) => entry.path).sort()).toEqual(
      [
        "environment/Dockerfile",
        "instruction.md",
        "solution/gold.patch",
        "solution/solve.sh",
        "task.toml",
      ].map((path) => `${id}/${path}`),
    );
    expect(found.find((entry) => entry.path.endsWith("solve.sh"))?.mode).toBe(0o755);
    const again = await get(`/api/public/releases/published-release/tasks/${id}/${id}.tar.gz`, {
      headers: { "if-none-match": response.headers.get("etag") ?? "" },
    });
    expect(again.status).toBe(304);
  }
});

test("a task's files and its download never share an address, whatever the task is called", async () => {
  const get = await serve();
  const files = await get("/api/public/releases/published-release/tasks/odd.tar.gz");
  expect(files.headers.get("content-type")).toContain("application/json");
  expect((await files.json()).taskId).toBe("odd.tar.gz");
  const download = await get(
    "/api/public/releases/published-release/tasks/odd.tar.gz/odd.tar.gz.tar.gz",
  );
  expect(download.headers.get("content-type")).toBe("application/gzip");
  // The old shape names no task, and a download must name its own task.
  expect((await get("/api/public/releases/published-release/tasks/next-pr-1.tar.gz")).status).toBe(
    404,
  );
  expect(
    (await get("/api/public/releases/published-release/tasks/next-pr-1/next-pr-2.tar.gz")).status,
  ).toBe(404);
});
