import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { LocalArtifactStore } from "../src/artifacts/local.js";
import { customerPackage, type ExportRegistry } from "../src/customer-exports/package.js";
import type { CustomerExportRequest } from "../src/customer-exports/types.js";
import { gzippedTar } from "./support/tar.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const source = "us-central1-docker.pkg.dev/project/selfbench-tasks";
const id = "12345678-1234-4234-8234-123456789abc";
const agent = `${source}/run/task/agent@sha256:${"a".repeat(64)}`;
const verifier = `${source}/run/task/verifier@sha256:${"b".repeat(64)}`;
const registry: ExportRegistry = {
  host: "selfbench.example",
  repository: source,
  password: "rg_grant.secret",
  expiresAt: new Date("2026-12-01T00:00:00Z"),
};
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
    evaluationId: crypto.randomUUID(),
    evaluationCreatedAt: "2026-10-01T00:00:00Z",
    grantId: crypto.randomUUID(),
    createdAt: "2026-10-01T00:00:00Z",
    createdBy: "owner",
    tasks: [
      { runId: "run", taskId: "../../untrusted-name", bundleKey, images: { agent, verifier } },
    ],
  };
  return { store, request };
}
test("a deterministic Harbor ZIP pulls both exact digests from SelfBench with the export's key", async () => {
  const { store, request } = await fixture();
  const task = request.tasks[0];
  if (!task) throw new Error("Missing fixture task");
  request.tasks.push({ ...task });
  const zip = await customerPackage(store, request, registry);
  const files = unzipSync(zip);
  const text = (name: string) => strFromU8(files[name] ?? new Uint8Array());
  expect(text("tasks/task-0001/environment/Dockerfile")).toBe(
    `FROM selfbench.example/run/task/agent@sha256:${"a".repeat(64)}\n`,
  );
  expect(text("tasks/task-0002/tests/Dockerfile")).toBe(
    `FROM selfbench.example/run/task/verifier@sha256:${"b".repeat(64)}\n`,
  );
  expect(text("tasks/task-0001/tests/test.patch")).toBe("hidden tests");
  expect(text("README.md")).toContain(
    "echo 'rg_grant.secret' | docker login selfbench.example --username export --password-stdin",
  );
  expect(text("README.md")).toContain("works until 2026-12-01");
  expect(text("README.md")).not.toContain("gcloud");
  expect(
    Object.keys(files).some((name) => name.includes("..") || name.includes("repo.tar.gz")),
  ).toBe(false);
  expect(
    Object.values(files)
      .map((value) => strFromU8(value))
      .join("\n"),
  ).not.toContain(source);
  expect(await customerPackage(store, request, registry)).toEqual(zip);
});
test("exports refuse historical build bundles, foreign images, service contexts, or unexpected Dockerfiles", async () => {
  const { store, request } = await fixture();
  const original = request.tasks[0];
  if (!original) throw new Error("Missing fixture task");
  request.tasks = [{ ...original, bundleKey: "original/harbor-task.tar.gz" }];
  await expect(customerPackage(store, request, registry)).rejects.toThrow(
    "frozen execution bundle",
  );
  request.tasks = [
    { ...original, images: { agent: agent.replace(source, "attacker.example/repo"), verifier } },
  ];
  await expect(customerPackage(store, request, registry)).rejects.toThrow("task image repository");
  const composed = await fixture({ "harbor-task/tests/docker-compose.yaml": "services: {}" });
  await expect(customerPackage(composed.store, composed.request, registry)).rejects.toThrow(
    "services",
  );
  const changed = await fixture({
    "harbor-task/environment/Dockerfile": `FROM ${agent}\nRUN curl example.com`,
  });
  await expect(customerPackage(changed.store, changed.request, registry)).rejects.toThrow(
    "unexpected image context",
  );
});
test("patches above the viewer limit are exported in full within the package budget", async () => {
  const patch = "x".repeat(2 * 1024 * 1024 + 100);
  const { store, request } = await fixture({ "harbor-task/tests/test.patch": patch });
  const zip = await customerPackage(store, request, registry);
  expect(strFromU8(unzipSync(zip)["tasks/task-0001/tests/test.patch"] ?? new Uint8Array())).toBe(
    patch,
  );
});
