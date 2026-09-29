import { describe, expect, test } from "bun:test";
import type { TaskEnvironment } from "../../src/contracts/index.js";
import {
  parseImageReference,
  pinEnvironmentImages,
  RegistryUnavailableError,
  resolveImage,
} from "../../src/generation/task/image-registry.js";

const digest = `sha256:${"a".repeat(64)}`;
const other = `sha256:${"c".repeat(64)}`;

/** A registry that serves `served` (tag or digest → content digest) behind Docker Hub's token dance. */
function registry(served: Record<string, string>, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.host}${url.pathname}`);
    if (url.host === "auth.docker.io") return Response.json({ token: "anonymous" });
    const [repository, target] = url.pathname.split("/manifests/");
    if (new Headers(init?.headers).get("authorization") !== "Bearer anonymous") {
      return new Response(null, {
        status: 401,
        headers: {
          "www-authenticate": `Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:${repository?.slice(4)}:pull"`,
        },
      });
    }
    const content = served[`${repository}:${target}`];
    if (!content) return new Response(null, { status: 404 });
    return new Response(null, { status: 200, headers: { "docker-content-digest": content } });
  }) as typeof fetch;
}

describe("image references", () => {
  test("address Docker Hub, other registries, and ports the way the registry does", () => {
    expect(parseImageReference("node:22-bookworm")).toEqual({
      name: "node",
      host: "registry-1.docker.io",
      repository: "library/node",
      tag: "22-bookworm",
    });
    expect(parseImageReference(`bitnami/redis:7@${digest}`)).toMatchObject({
      host: "registry-1.docker.io",
      repository: "bitnami/redis",
      tag: "7",
      digest,
    });
    expect(parseImageReference(`ghcr.io/org/app@${digest}`)).toMatchObject({
      name: "ghcr.io/org/app",
      host: "ghcr.io",
      repository: "org/app",
      digest,
    });
    expect(parseImageReference("registry:5000/team/app:1")).toMatchObject({
      host: "registry:5000",
      repository: "team/app",
      tag: "1",
    });
    expect(parseImageReference("Node:22")).toBeUndefined();
  });
});

describe("resolving images", () => {
  test("pins a tag to the digest its registry serves now", async () => {
    const calls: string[] = [];
    const fetch = registry({ "/v2/library/node:22-bookworm": digest }, calls);
    expect(await resolveImage("node:22-bookworm", { fetch })).toEqual({
      ok: true,
      image: `node:22-bookworm@${digest}`,
    });
    expect(calls).toEqual([
      "HEAD registry-1.docker.io/v2/library/node/manifests/22-bookworm",
      "GET auth.docker.io/token",
      "HEAD registry-1.docker.io/v2/library/node/manifests/22-bookworm",
    ]);
  });

  test("keeps a digest the registry serves and reports one it does not", async () => {
    const fetch = registry({ [`/v2/library/node:${digest}`]: digest });
    const pinned = `node:22-bookworm@${digest}`;
    expect(await resolveImage(pinned, { fetch })).toEqual({ ok: true, image: pinned });
    const invented = await resolveImage(`node:22-bookworm@${other}`, { fetch });
    expect(!invented.ok && invented.problem).toContain(
      `docker.io/library/node does not serve digest ${other}`,
    );
    expect(!invented.ok && invented.problem).toContain(
      "name the tag alone (node:22-bookworm) and the worker pins it",
    );
    const typo = await resolveImage("node:22-bookwrom", { fetch });
    expect(!typo.ok && typo.problem).toContain("does not serve tag 22-bookwrom");
  });

  test("hashes the manifest when the registry sends no digest header", async () => {
    const body = new TextEncoder().encode('{"schemaVersion":2}');
    const manifest = (async (_input: string | URL | Request, init?: RequestInit) =>
      init?.method === "HEAD"
        ? new Response(null, { status: 200 })
        : new Response(body, { status: 200 })) as typeof globalThis.fetch;
    const expected = new Bun.CryptoHasher("sha256").update(body).digest("hex");
    expect(await resolveImage("ghcr.io/org/app:1", { fetch: manifest })).toEqual({
      ok: true,
      image: `ghcr.io/org/app:1@sha256:${expected}`,
    });
  });

  test("a registry that cannot answer is retried, never charged to the author", async () => {
    const down = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
    await expect(resolveImage("node:22", { fetch: down })).rejects.toBeInstanceOf(
      RegistryUnavailableError,
    );
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(resolveImage("node:22", { fetch: offline })).rejects.toBeInstanceOf(
      RegistryUnavailableError,
    );
  });

  test("pins every image in an environment and names the field of each missing one", async () => {
    const fetch = registry({
      "/v2/library/node:22-bookworm": digest,
      "/v2/library/postgres:16": other,
    });
    const healthcheck = {
      test: ["CMD", "true"],
      intervalSeconds: 1,
      timeoutSeconds: 1,
      retries: 1,
      startPeriodSeconds: 0,
    };
    const environment = {
      baseImage: "node:22-bookworm",
      services: [
        { name: "db", image: "postgres:16", environmentVariables: {}, healthcheck },
        { name: "cache", image: "redis:nope", environmentVariables: {}, healthcheck },
      ],
    } as unknown as TaskEnvironment;
    const pinned = await pinEnvironmentImages(environment, { fetch });
    expect(pinned.environment.baseImage).toBe(`node:22-bookworm@${digest}`);
    expect(pinned.environment.services.map((service) => service.image)).toEqual([
      `postgres:16@${other}`,
      "redis:nope",
    ]);
    expect(pinned.problems).toEqual([
      expect.stringContaining("service cache image redis:nope: docker.io/library/redis"),
    ]);
  });
});
