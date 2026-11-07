import { expect, test } from "bun:test";
import { inferResourceLimits } from "../../src/sandbox/resource-inference.js";
import {
  checkResources,
  requestedResources,
  resourceRefusal,
} from "../../src/sandbox/resources.js";

test("a task.toml's resources are read in MiB, from numbers or Harbor's size strings", () => {
  expect(requestedResources({ environment: { cpus: 2, memory_mb: 4096, storage: "20G" } })).toEqual(
    { cpus: 2, memoryMb: 4096, storageMb: 20480 },
  );
  expect(requestedResources({ environment: { memory: "512M", storage_mb: "nonsense" } })).toEqual({
    memoryMb: 512,
  });
  expect(requestedResources({})).toEqual({});
});

test("a request over a limit is an error; one near it or rounded by the provider is a warning", () => {
  const limits = { cpus: 8, memoryMb: 8192, storageMb: 10240 };
  expect(checkResources({ cpus: 16, memoryMb: 16384 }, limits, "e2b").errors).toEqual([
    "asks for 16 CPUs; the limit is 8",
    "asks for 16 GiB memory; the limit is 8 GiB",
  ]);
  const near = checkResources({ cpus: 1.5, storageMb: 10000 }, limits, "e2b");
  expect(near.errors).toEqual([]);
  expect(near.warnings).toEqual([
    "asks for 9.8 GiB storage, close to the limit of 10 GiB",
    "asks for 1.5 CPUs; E2B gives whole CPUs, so it gets 1",
  ]);
  // No saved limit, or no request, checks nothing.
  expect(checkResources({ cpus: 64 }, undefined, "modal")).toEqual({ errors: [], warnings: [] });
  expect(checkResources({}, limits, "modal")).toEqual({ errors: [], warnings: [] });
});

test("a refusal names each task over a limit, at most five", () => {
  const problems = Array.from({ length: 7 }, (_, index) => ({
    task: `task-${index}`,
    errors: ["asks for 16 CPUs; the limit is 8"],
  }));
  const refusal = resourceRefusal([{ task: "fits", errors: [] }, ...problems]) ?? "";
  expect(refusal).toContain("task-0 asks for 16 CPUs; the limit is 8");
  expect(refusal).toContain("task-4");
  expect(refusal).not.toContain("task-5");
  expect(refusal).toContain("and 2 more tasks");
  expect(resourceRefusal([{ task: "fits", errors: [] }])).toBeUndefined();
});

test("a Daytona key's organization quotas become its limits, in MiB", async () => {
  const calls: { url: string; auth: string | null }[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
    return url.endsWith("/api-keys/current")
      ? Response.json({ name: "eval", organizationId: "org-2" })
      : Response.json({ maxCpuPerSandbox: 4, maxMemoryPerSandbox: 8, maxDiskPerSandbox: 10 });
  }) as unknown as typeof fetch;
  expect(await inferResourceLimits("daytona", { value: "dtn_key" }, fetcher)).toEqual({
    limits: { cpus: 4, memoryMb: 8192, storageMb: 10240 },
    source: "Daytona organization quotas",
  });
  // The key's own organization, never one picked from its user's memberships.
  expect(calls).toEqual([
    { url: "https://app.daytona.io/api/api-keys/current", auth: "Bearer dtn_key" },
    { url: "https://app.daytona.io/api/organizations/org-2", auth: "Bearer dtn_key" },
  ]);
});

test("a provider that refuses or does not share its limits infers none", async () => {
  const refused = (async () => new Response("no", { status: 403 })) as unknown as typeof fetch;
  expect((await inferResourceLimits("daytona", { value: "k" }, refused)).limits).toBeUndefined();
  const failing = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;
  expect((await inferResourceLimits("daytona", { value: "k" }, failing)).limits).toBeUndefined();
  expect((await inferResourceLimits("e2b", { value: "k" })).limits).toBeUndefined();
  expect((await inferResourceLimits("vercel", { value: "k" })).limits).toEqual({
    cpus: 32,
    memoryMb: 65536,
  });
});
