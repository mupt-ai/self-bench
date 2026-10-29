import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../../src/artifacts/index.js";
import type { TaskImages } from "../../src/contracts/index.js";
import type { Vault } from "../../src/db/vault.js";
import type { TaskImageBuilder } from "../../src/generation/images/builder.js";
import { notRunGates, type runHarborGates } from "../../src/generation/pipeline/harbor-gates.js";
import {
  type RebuildDependencies,
  rebuildTaskImages,
  verificationEnvironment,
} from "../../src/generation/tasks/task-image-rebuild.js";
import type { ReviewedTask } from "../../src/generation/tasks/task-images.js";
import { gzippedTar, tarEntries } from "../support/tar.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const attempt = "runs/run-1/verify/cand/authoring-round-1/compile/attempt-1";
const images: TaskImages = {
  agent: `us-central1-docker.pkg.dev/p/selfbench-tasks/run-1/cand/agent@sha256:${"a".repeat(64)}`,
  verifier: `us-central1-docker.pkg.dev/p/selfbench-tasks/run-1/cand/verifier@sha256:${"b".repeat(64)}`,
};
const task: ReviewedTask = {
  id: 7,
  runId: "run-1",
  candidateId: "cand",
  taskId: "task",
  pipelineStatus: "accepted",
  bundleKey: `${attempt}/harbor-task.tar.gz`,
  images: null,
  reviewDecision: "approve",
  deletedAt: null,
};

/** A task accepted before images: a full compiled bundle, and no gate task beside it. */
async function legacy() {
  const root = await mkdtemp(join(tmpdir(), "selfbench-rebuild-"));
  roots.push(root);
  const store = new LocalArtifactStore(root);
  const files = {
    "harbor-task/instruction.md": "Fix it.\n",
    "harbor-task/task.toml": 'schema_version = "1.4"\n',
    "harbor-task/tests/test.sh": "test",
    "harbor-task/tests/test.patch": "hidden",
    "harbor-task/tests/docker-compose.yaml": '{"services":{"main":{"build":"."}}}',
    "harbor-task/solution/solve.sh": "solve",
    "harbor-task/solution/gold.patch": "gold",
    "harbor-task/environment/Dockerfile": "FROM base\nCOPY repo.tar.gz /tmp/\n",
    "harbor-task/tests/Dockerfile": "FROM base\nCOPY repo.tar.gz /tmp/\n",
    "harbor-task/environment/repo.tar.gz": "repo",
    "harbor-task/tests/repo.tar.gz": "repo",
  };
  await store.put(`${attempt}/harbor-task.tar.gz`, await gzippedTar(files), "application/gzip");
  return store;
}

function deps(gates: (images: TaskImages) => Awaited<ReturnType<typeof runHarborGates>>) {
  const saved: unknown[] = [];
  /** Each discard, by the pair it keeps; `null` keeps nothing but what is pinned elsewhere. */
  const discarded: (TaskImages | null)[] = [];
  const builds: unknown[] = [];
  const value: RebuildDependencies = {
    builder: { build: async () => ({ images }) } satisfies TaskImageBuilder,
    verification: { provider: "e2b", env: { E2B_API_KEY: "org-key" }, orgId: 1, credentialId: "c" },
    serving: { env: {} },
    save: async (bundleKey, recorded) => {
      saved.push({ bundleKey, recorded });
      return true;
    },
    discardImages: async (keep) => {
      discarded.push(keep ?? null);
    },
    signal: new AbortController().signal,
    now: () => new Date("2026-10-25T00:00:00Z"),
    gates: async (store, _task, provider, _prefix, signal, built) => {
      builds.push({ provider, build: built?.build });
      if (built) await built.builder.build(store, built.build, signal);
      return gates(images);
    },
  };
  return { value, saved, discarded, builds };
}

const passing = (built: TaskImages) => {
  const gates = notRunGates();
  for (const name of ["build", "smoke", "nop", "oracle"] as const) gates[name].ok = true;
  return { ...gates, images: built };
};

test("a legacy task is split once, rebuilt, checked again on its own provider, and recorded", async () => {
  const store = await legacy();
  const { value, saved, discarded, builds } = deps(passing);
  const outcome = await rebuildTaskImages(store, task, value);
  expect(outcome).toMatchObject({ status: "rebuilt", images });
  // The gate task and snapshot are now stored beside the compiled bundle.
  const gate = await store.getByKey(`${attempt}/gate-task.tar.gz`);
  expect(
    (await tarEntries(Buffer.from(gate ?? []))).some((e) => e.path.endsWith("repo.tar.gz")),
  ).toBe(false);
  expect(Buffer.from((await store.getByKey(`${attempt}/repo.tar.gz`)) ?? []).toString()).toBe(
    "repo",
  );
  expect(builds).toMatchObject([
    { provider: "e2b", build: { runId: "run-1", candidateId: "cand" } },
  ]);
  expect(saved).toEqual([
    {
      bundleKey: expect.stringMatching(/execution-[0-9a-f]+\/execution-task.tar.gz$/),
      recorded: images,
    },
  ]);
  // Only the recorded pair survives the cleanup of earlier attempts.
  expect(discarded).toEqual([images]);
});

test("images that fail a gate are deleted and the row is left alone", async () => {
  const store = await legacy();
  const { value, saved, discarded } = deps((built) => ({
    ...passing(built),
    oracle: notRunGates().oracle,
  }));
  expect(await rebuildTaskImages(store, task, value)).toMatchObject({
    status: "failed",
    gate: "oracle",
    outputs: `${attempt}/rebuild-2026-10-25T00-00-00-000Z`,
  });
  expect(saved).toEqual([]);
  expect(discarded).toEqual([null]);
});

test("only kept tasks without images are rebuilt", async () => {
  const store = await legacy();
  const { value, builds } = deps(passing);
  for (const other of [
    { ...task, images },
    { ...task, reviewDecision: "reject" as const },
    { ...task, deletedAt: new Date() },
    { ...task, pipelineStatus: "rejected" as const },
  ])
    expect((await rebuildTaskImages(store, other, value)).status).toBe("skipped");
  expect(builds).toEqual([]);
});

test("verification uses saved customer credentials or explicit managed platform credentials", async () => {
  const vault = (settings: Record<string, unknown>) =>
    ({
      records: { read: async () => ({ value: { ownerId: 7, orgId: 42, settings } }) },
      credentials: {
        find: async (org: number) => (org === 42 ? { kind: "modal", auth: "api-key" } : undefined),
        secret: async () => ({ value: "modal-secret", tokenId: "modal-id" }),
      },
    }) as unknown as Vault;
  const found = await verificationEnvironment(
    vault({ sandbox: "e2b", harborEnvironment: "modal", harborCredentialId: "modal-key" }),
    "run-1",
    { PATH: "/usr/bin", MODAL_TOKEN_ID: "worker-own" },
  );
  expect(found).toMatchObject({ provider: "modal", orgId: 42, credentialId: "modal-key" });
  expect(found.env.MODAL_TOKEN_ID).not.toBe("worker-own");
  const managed = vault({ sandbox: "managed" });
  managed.credentials.find = async () => {
    throw new Error("Managed runs must not read customer credentials");
  };
  const base = {
    PATH: "/usr/bin",
    SELFBENCH_MANAGED_OFFERING: "true",
    SELFBENCH_MANAGED_E2B_API_KEY: "platform-e2b",
    E2B_API_KEY: "worker-e2b",
    MODAL_TOKEN_ID: "worker-modal",
    MODAL_TOKEN_SECRET: "worker-secret",
  };
  const e2b = await verificationEnvironment(managed, "run-1", base);
  expect(e2b).toMatchObject({ provider: "e2b", orgId: 42 });
  expect(e2b.credentialId).toBeUndefined();
  expect(e2b.env.E2B_API_KEY).toBe("platform-e2b");
  expect(e2b.env.MODAL_TOKEN_ID).toBeUndefined();
  const modal = await verificationEnvironment(managed, "run-1", {
    ...base,
    SELFBENCH_MANAGED_MODAL_TOKEN_ID: "platform-modal",
    SELFBENCH_MANAGED_MODAL_TOKEN_SECRET: "platform-secret",
    SELFBENCH_MANAGED_MODAL_ENVIRONMENT: "production",
  });
  expect(modal.provider).toBe("modal");
  expect(modal.credentialId).toBeUndefined();
  expect(modal.env.MODAL_TOKEN_ID).toBe("platform-modal");
  expect(modal.env.MODAL_TOKEN_SECRET).toBe("platform-secret");
  expect(modal.env.MODAL_ENVIRONMENT).toBe("production");
  expect(modal.env.E2B_API_KEY).toBeUndefined();
  // An operator may name an organization's own credential for managed runs instead.
  const named = vault({ sandbox: "managed" });
  const own = await verificationEnvironment(
    named,
    "run-1",
    { PATH: "/usr/bin" },
    {
      orgId: 42,
      credentialId: "modal-key",
    },
  );
  expect(own).toMatchObject({ provider: "modal", orgId: 42, credentialId: "modal-key" });
  expect(own.env.MODAL_TOKEN_ID).toBe("modal-id");
  await expect(
    verificationEnvironment(named, "run-1", {}, { orgId: 9, credentialId: "modal-key" }),
  ).rejects.toThrow("Verification credential is unavailable");
  for (const env of [{}, { ...base, SELFBENCH_MANAGED_OFFERING: "false" }])
    await expect(verificationEnvironment(managed, "run-1", env)).rejects.toThrow(
      "Managed sandboxes are not configured",
    );
});

test("images the row never takes are deleted, whatever stopped the rebuild", async () => {
  const store = await legacy();
  const refused = deps(passing);
  const value = { ...refused.value, save: async () => false };
  await expect(rebuildTaskImages(store, task, value)).rejects.toThrow("Task changed");
  expect(refused.discarded).toEqual([null]);
  const lost = deps(() => {
    throw new Error("worker lost");
  });
  await expect(rebuildTaskImages(store, task, lost.value)).rejects.toThrow("worker lost");
  expect(lost.discarded).toEqual([null]);
});

test("a legacy split streams its gate task and snapshot from disk, never through memory", async () => {
  const store = await legacy();
  const put = store.put.bind(store);
  store.put = async (key, value, contentType) => {
    if (key === `${attempt}/gate-task.tar.gz` || key === `${attempt}/repo.tar.gz`)
      throw new Error(`buffered ${key}`);
    return await put(key, value, contentType);
  };
  const { value } = deps(passing);
  expect(await rebuildTaskImages(store, task, value)).toMatchObject({ status: "rebuilt" });
  expect(await store.stat(`${attempt}/repo.tar.gz`)).toBeTruthy();
});

test("a build that pushed only part of its pair is cleaned up, though it reported no images", async () => {
  const store = await legacy();
  const partial = deps(passing);
  const value: RebuildDependencies = {
    ...partial.value,
    builder: {
      build: async () => {
        throw new Error("verifier push failed after the agent pushed");
      },
    },
  };
  await expect(rebuildTaskImages(store, task, value)).rejects.toThrow("verifier push failed");
  expect(partial.discarded).toEqual([null]);
});
