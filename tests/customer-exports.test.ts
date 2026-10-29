import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { LocalArtifactStore } from "../src/artifacts/local.js";
import { customerPackage } from "../src/customer-exports/package.js";
import { copyCustomerImages, customerRegistry } from "../src/customer-exports/registry.js";
import { type CustomerExportRequest, customerRepository } from "../src/customer-exports/types.js";
import { gzippedTar } from "./support/tar.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const source = "us-central1-docker.pkg.dev/project/selfbench-tasks";
const id = "12345678-1234-4234-8234-123456789abc";
const agent = `${source}/run/task/agent@sha256:${"a".repeat(64)}`;
const verifier = `${source}/run/task/verifier@sha256:${"b".repeat(64)}`;
const destination = customerRepository(source, 1, id);
test("customer repository identities are isolated even when tenants reuse an export ID", () => {
  expect(customerRepository(source, 2, id)).not.toBe(destination);
});
async function fixture(extra: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "customer-export-"));
  roots.push(root);
  const store = new LocalArtifactStore(root);
  const bundleKey = "runs/run/verify/task/execution-hash/execution-task.tar.gz";
  await store.put(
    bundleKey,
    await gzippedTar({
      "harbor-task/instruction.md": "Fix the task.",
      "harbor-task/task.toml": '[verifier]\nenvironment_mode = "separate"\n',
      "harbor-task/environment/Dockerfile": `FROM ${agent}\n`,
      "harbor-task/tests/Dockerfile": `FROM ${verifier}\n`,
      "harbor-task/tests/test.sh": "#!/bin/bash\ntrue\n",
      "harbor-task/tests/test.patch": "hidden tests",
      "harbor-task/solution/solve.sh": "#!/bin/bash\ntrue\n",
      "harbor-task/solution/gold.patch": "reference patch",
      ...extra,
    }),
    "application/gzip",
  );
  const request: CustomerExportRequest = {
    id,
    repoId: 1,
    customer: "Acme",
    email: "customer@example.com",
    evaluationId: crypto.randomUUID(),
    createdAt: "2026-10-01T00:00:00Z",
    createdBy: "owner",
    tasks: [
      { runId: "run", taskId: "../../untrusted-name", bundleKey, images: { agent, verifier } },
    ],
  };
  return { store, request };
}
test("a deterministic Harbor ZIP contains both exact image digests, grading and setup, with no proxy or snapshot", async () => {
  const { store, request } = await fixture();
  const task = request.tasks[0];
  if (!task) throw new Error("Missing fixture task");
  request.tasks.push({ ...task });
  const packed = await customerPackage(store, request, source, destination);
  expect(packed.images).toHaveLength(2);
  const files = unzipSync(packed.zip);
  expect(strFromU8(files["tasks/task-0001/environment/Dockerfile"] ?? new Uint8Array())).toBe(
    `FROM ${agent.replace(source, destination)}\n`,
  );
  expect(strFromU8(files["tasks/task-0002/tests/Dockerfile"] ?? new Uint8Array())).toBe(
    `FROM ${verifier.replace(source, destination)}\n`,
  );
  expect(strFromU8(files["tasks/task-0001/tests/test.patch"] ?? new Uint8Array())).toBe(
    "hidden tests",
  );
  expect(strFromU8(files["README.md"] ?? new Uint8Array())).toContain(
    `gcloud auth configure-docker ${destination.split("/")[0]}`,
  );
  expect(
    Object.keys(files).some((name) => name.includes("..") || name.includes("repo.tar.gz")),
  ).toBe(false);
  expect(
    Object.values(files)
      .map((value) => strFromU8(value))
      .join("\n"),
  ).not.toContain("/selfbench-tasks/");
  expect((await customerPackage(store, request, source, destination)).zip).toEqual(packed.zip);
});
test("exports refuse historical build bundles, foreign images, service contexts, or unexpected Dockerfiles", async () => {
  const { store, request } = await fixture();
  const original = request.tasks[0];
  if (!original) throw new Error("Missing fixture task");
  request.tasks = [{ ...original, bundleKey: "original/harbor-task.tar.gz" }];
  await expect(customerPackage(store, request, source, destination)).rejects.toThrow(
    "frozen execution bundle",
  );
  request.tasks = [
    { ...original, images: { agent: agent.replace(source, "attacker.example/repo"), verifier } },
  ];
  await expect(customerPackage(store, request, source, destination)).rejects.toThrow(
    "verified images",
  );
  const composed = await fixture({ "harbor-task/tests/docker-compose.yaml": "services: {}" });
  await expect(
    customerPackage(composed.store, composed.request, source, destination),
  ).rejects.toThrow("services");
  const changed = await fixture({
    "harbor-task/environment/Dockerfile": `FROM ${agent}\nRUN curl example.com`,
  });
  await expect(
    customerPackage(changed.store, changed.request, source, destination),
  ).rejects.toThrow("unexpected image context");
});
test("registry provisioning grants only one dedicated repository and preserves IAM etags and bindings", async () => {
  const calls: { url: string; init?: RequestInit | undefined }[] = [];
  const registry = customerRegistry(source, {
    token: async () => "secret-access-token",
    fetch: async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith(":getIamPolicy"))
        return Response.json({
          etag: "etag",
          bindings: [
            { role: "roles/artifactregistry.reader", members: ["user:existing@example.com"] },
          ],
        });
      return Response.json({});
    },
  });
  await registry.create(destination);
  await registry.grant(destination, "customer@example.com");
  const policy = JSON.parse(String(calls.at(-1)?.init?.body)).policy;
  expect(policy.etag).toBe("etag");
  expect(policy.bindings[0].members).toEqual([
    "user:existing@example.com",
    "user:customer@example.com",
  ]);
  expect(calls.every((call) => call.url.includes(`/repositories/customer-1-${id}`))).toBe(true);
  await expect(registry.grant(source, "customer@example.com")).rejects.toThrow("dedicated");
});
test("missing repositories are created privately and polled before returning", async () => {
  const calls: string[] = [];
  const registry = customerRegistry(source, {
    token: async () => "token",
    fetch: async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (init?.method === "POST") {
        expect(JSON.parse(String(init.body)).format).toBe("DOCKER");
        return Response.json({ name: "projects/project/locations/us-central1/operations/create" });
      }
      if (url.includes("/operations/")) return Response.json({ done: true });
      return new Response(null, { status: 404 });
    },
  });
  await registry.create(destination);
  expect(calls).toHaveLength(3);
});
test("copy builds preserve digests, use short-lived build credentials and propagate failure", async () => {
  let build: Record<string, unknown> | undefined;
  const cloud = {
    run: async (value: Record<string, unknown>) => {
      build = value;
      return { id: "build", status: "SUCCESS" };
    },
    log: async () => "",
  };
  await copyCustomerImages(
    cloud,
    [{ source: agent, destination: agent.replace(source, destination) }],
    new AbortController().signal,
  );
  expect(JSON.stringify(build)).toContain("--preserve-digests");
  expect(JSON.stringify(build)).toContain("$$token");
  expect(JSON.stringify(build)).not.toContain("secret-access-token");
  await expect(
    copyCustomerImages(
      { ...cloud, run: async () => ({ id: "build", status: "FAILURE" }) },
      [],
      new AbortController().signal,
    ),
  ).rejects.toThrow("Image copy failed");
});
