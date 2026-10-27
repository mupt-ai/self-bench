import { expect, test } from "bun:test";
import { googleCloudBuild } from "../../src/generation/images/cloud-build-api.js";

const config = {
  kind: "cloud-build" as const,
  project: "p",
  region: "us-central1",
  serviceAccount: "builder@p.iam.gserviceaccount.com",
  logsBucket: "p-task-builds",
};

/** Cloud Build's API answering with `statuses` in turn, recording what it was asked. */
function api(statuses: string[]) {
  const requests: { url: string; method: string; body?: unknown }[] = [];
  const access = {
    token: async () => "token",
    fetch: async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({
        url,
        method,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      if (method === "POST" && url.endsWith("/builds"))
        return Response.json({ metadata: { build: { id: "b1" } } });
      if (method === "POST") return Response.json({});
      return Response.json({ id: "b1", status: statuses.shift() ?? "WORKING" });
    },
  };
  return { cloud: googleCloudBuild(config, access, 1), requests };
}

test("a build runs as the builder's account, logs to its bucket, and is followed to its end", async () => {
  const { cloud, requests } = api(["QUEUED", "WORKING", "SUCCESS"]);
  const finished = await cloud.run({ steps: [] }, new AbortController().signal);
  expect(finished).toMatchObject({ id: "b1", status: "SUCCESS" });
  expect(requests[0]).toMatchObject({
    url: "https://cloudbuild.googleapis.com/v1/projects/p/locations/us-central1/builds",
    body: {
      serviceAccount: "projects/p/serviceAccounts/builder@p.iam.gserviceaccount.com",
      logsBucket: "gs://p-task-builds",
      options: { logging: "GCS_ONLY" },
    },
  });
});

test("a cancelled activity cancels its build and ends as the cancellation", async () => {
  const { cloud, requests } = api(["WORKING", "CANCELLED"]);
  const controller = new AbortController();
  const running = cloud.run({ steps: [] }, controller.signal);
  controller.abort(new Error("activity cancelled"));
  await expect(running).rejects.toThrow("activity cancelled");
  expect(requests.some((request) => request.url.endsWith("/builds/b1:cancel"))).toBe(true);
});
