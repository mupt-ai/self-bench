import { afterEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { taskImageRegistry } from "../src/api/routes/registry.js";
import { REGISTRY_USERNAME, signRegistryGrant } from "../src/sandbox/registry-grant.js";

const SECRET = "s".repeat(32);
const REPOSITORY = "us-central1-docker.pkg.dev/selfbench-test/selfbench-tasks";
const UPSTREAM = "https://us-central1-docker.pkg.dev/v2/selfbench-test/selfbench-tasks";
const digest = (character: string) => `sha256:${character.repeat(64)}`;
const INDEX = digest("1");
const MANIFEST = digest("2");
const CONFIG = digest("3");
const LAYER = digest("4");
const OTHER = digest("9");

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

/** Artifact Registry stand-in: one task image (an index over one manifest), blobs redirected. */
function upstream(requests: string[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push(`${init?.method ?? "GET"} ${url}`);
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Basic ${Buffer.from("oauth2accesstoken:upstream-token").toString("base64")}`,
    );
    if (url === `${UPSTREAM}/task-1/manifests/${INDEX}`)
      return Response.json(
        { mediaType: "application/vnd.oci.image.index.v1+json", manifests: [{ digest: MANIFEST }] },
        {
          headers: {
            "content-type": "application/vnd.oci.image.index.v1+json",
            "docker-content-digest": INDEX,
          },
        },
      );
    if (url === `${UPSTREAM}/task-1/manifests/${MANIFEST}`)
      return Response.json(
        { config: { digest: CONFIG }, layers: [{ digest: LAYER }] },
        { headers: { "content-type": "application/vnd.oci.image.manifest.v1+json" } },
      );
    if (url === `${UPSTREAM}/task-1/blobs/${LAYER}`)
      return new Response(null, {
        status: 302,
        headers: { location: "/artifacts-downloads/namespaces/selfbench-test/downloads/abc" },
      });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

async function serve(requests: string[] = []): Promise<string> {
  const handle = taskImageRegistry({
    repository: REPOSITORY,
    token: async () => "upstream-token",
    fetch: upstream(requests),
  });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (!(await handle(request, url, response, SECRET))) response.writeHead(418).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function login(images: string[], expiresAt = Date.now() + 60_000): Record<string, string> {
  const password = signRegistryGrant({ images, expiresAt }, SECRET);
  return {
    authorization: `Basic ${Buffer.from(`${REGISTRY_USERNAME}:${password}`).toString("base64")}`,
  };
}

test("a pull grant reaches exactly its own task image's manifests and blobs", async () => {
  const origin = await serve();
  const headers = login([`task-1@${INDEX}`]);

  const ping = await fetch(`${origin}/v2/`, { headers });
  expect(ping.status).toBe(200);
  const index = await fetch(`${origin}/v2/task-1/manifests/${INDEX}`, { headers });
  expect(index.status).toBe(200);
  expect(index.headers.get("docker-content-digest")).toBe(INDEX);
  expect((await index.json()).manifests).toEqual([{ digest: MANIFEST }]);
  expect((await fetch(`${origin}/v2/task-1/manifests/${MANIFEST}`, { headers })).status).toBe(200);

  // Layers go straight from Artifact Registry's one-blob download URL, not through the API.
  const blob = await fetch(`${origin}/v2/task-1/blobs/${LAYER}`, { headers, redirect: "manual" });
  expect(blob.status).toBe(307);
  expect(blob.headers.get("location")).toBe(
    "https://us-central1-docker.pkg.dev/artifacts-downloads/namespaces/selfbench-test/downloads/abc",
  );

  // Nothing the image does not name, and no other image or tag, whatever the grant holder asks.
  for (const path of [
    `/v2/task-1/blobs/${OTHER}`,
    `/v2/task-1/manifests/${OTHER}`,
    `/v2/task-2/manifests/${INDEX}`,
    "/v2/task-1/manifests/latest",
    `/v2/..%2Fother/task-1/manifests/${INDEX}`,
  ]) {
    expect((await fetch(`${origin}${path}`, { headers })).status).toBe(404);
  }
});

test("a granted image Artifact Registry cannot serve is a retryable upstream error", async () => {
  const origin = await serve();
  const response = await fetch(`${origin}/v2/repo--task__1/manifests/${INDEX}`, {
    headers: login([`repo--task__1@${INDEX}`]),
  });
  expect(response.status).toBe(502);
});

test("pulls without a valid grant are asked to log in", async () => {
  const requests: string[] = [];
  const origin = await serve(requests);
  const forged = login([`task-1@${INDEX}`]);
  forged.authorization = `Basic ${Buffer.from(`${REGISTRY_USERNAME}:x.y`).toString("base64")}`;
  for (const headers of [{}, forged, login([`task-1@${INDEX}`], Date.now() - 1)]) {
    const response = await fetch(`${origin}/v2/task-1/manifests/${INDEX}`, { headers });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Basic realm="SelfBench"');
  }
  expect(requests).toEqual([]);
  expect((await fetch(`${origin}/v2/`, { method: "DELETE", headers: login([]) })).status).toBe(405);
});
