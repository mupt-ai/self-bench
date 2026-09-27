import { afterEach, describe, expect, test } from "bun:test";
import { seededTaskSite } from "../support/ingest-tasks.js";
import type { AuthServer } from "../support/site-fixture.js";

let server: AuthServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function signedIn() {
  const fixture = await seededTaskSite({
    repos: [{ full_name: "Mupt-AI/self-bench" }, { full_name: "Mupt-AI/other" }],
    pullRequests: {
      46: {
        number: 46,
        merged: true,
        merge_commit_sha: "a".repeat(40),
        title: "Fix parser",
        body: "Handle empty input",
        additions: 80,
        deletions: 30,
        changed_files: 3,
        html_url: "https://github.com/Mupt-AI/self-bench/pull/46",
        user: { login: "author", type: "User" },
      },
    },
    start: async () => {},
  });
  server = fixture.site;
  return fixture;
}

const REPO = "/api/orgs/mupt-ai/repos/Mupt-AI/self-bench";

describe("task routes", () => {
  test("deletion is authorized, idempotent, durable across ingestion and keeps artifacts", async () => {
    const { site, headers, ingest, artifacts } = await signedIn();
    await ingest();
    await site.request("/api/orgs/mupt-ai/repos", {
      method: "POST",
      headers,
      body: JSON.stringify({ fullName: "Mupt-AI/other" }),
    });
    const path = `${REPO}/tasks/run-one/task-good`;
    expect((await site.request(path, { method: "DELETE" })).status).toBe(401);
    expect(
      (
        await site.request(path.replace("/orgs/mupt-ai/", "/orgs/outsider/"), {
          method: "DELETE",
          headers,
        })
      ).status,
    ).toBe(404);
    expect(
      (await site.request(path.replace("/self-bench/", "/other/"), { method: "DELETE", headers }))
        .status,
    ).toBe(404);
    expect((await site.request(`${path}/artifacts`, { headers })).status).toBe(200);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await site.request(path, { method: "DELETE", headers });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    }
    expect((await site.request(`${path}/artifacts`, { headers })).status).toBe(404);
    expect(
      (
        await site.request(`${path}/review`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ decision: "approve" }),
        })
      ).status,
    ).toBe(404);
    expect(
      (await site.request(`${REPO}/tasks/run-one/missing`, { method: "DELETE", headers })).status,
    ).toBe(404);
    await ingest();
    const list = (await (await site.request(`${REPO}/tasks`, { headers })).json()) as {
      tasks: { taskId: string }[];
    };
    expect(list.tasks.map((task) => task.taskId)).toEqual(["task-bad"]);
    expect(
      await (await site.request("/api/orgs/mupt-ai/task-counts", { headers })).json(),
    ).toMatchObject({
      counts: { "Mupt-AI/self-bench": { total: 1, needsReview: 0 } },
    });
    await ingest();
    const reingested = (await (await site.request(`${REPO}/tasks`, { headers })).json()) as {
      tasks: { taskId: string }[];
    };
    expect(reingested.tasks.map((task) => task.taskId)).toEqual(["task-bad"]);
    expect((await site.request(path, { method: "DELETE", headers })).status).toBe(200);
    expect(await artifacts.getByKey("runs/run-one/authoring/c1/definition.json")).toBeDefined();
    expect(
      Buffer.from(
        (await artifacts.getByKey(
          "runs/run-one/verification/c1/round-1/attempt-1/verify-1/harbor-task.tar.gz",
        )) ?? new Uint8Array(),
      ).toString(),
    ).toBe("tar");
  });

  test("active generation cannot be deleted even after a human review", async () => {
    const { site, headers } = await signedIn();
    const started = await site.request(`${REPO}/tasks/from-pr`, {
      method: "POST",
      headers,
      body: JSON.stringify({ pr: "https://github.com/Mupt-AI/self-bench/pull/46" }),
    });
    expect(started.status).toBe(201);
    const { task } = (await started.json()) as {
      task: { runId: string; taskId: string };
    };
    const path = `${REPO}/tasks/${task.runId}/${task.taskId}`;
    await site.request(`${path}/review`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ decision: "approve" }),
    });
    const response = await site.request(path, { method: "DELETE", headers });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Task generation is still in progress" });
    const list = (await (await site.request(`${REPO}/tasks`, { headers })).json()) as {
      tasks: unknown[];
    };
    expect(list.tasks).toHaveLength(1);
    expect(list.tasks[0]).toMatchObject({
      taskId: task.taskId,
      state: "accepted",
      pipelineStatus: "in_progress",
    });
  });
});
