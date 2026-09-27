import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TemplateClass } from "e2b";
import {
  ensureManagedE2BTemplate,
  MANAGED_E2B_TEMPLATE_CPUS,
  MANAGED_E2B_TEMPLATE_MEMORY_MIB,
  managedE2BTemplateRecordPath,
  managedE2BTemplateReference,
} from "../../../../src/sandbox/providers/e2b/managed-template.js";
import type { E2BTemplateBuildApi } from "../../../../src/sandbox/providers/e2b/template-build.js";
import { MemoryRecords } from "../../../support/evaluation-vault.js";

const CREDENTIALS = { apiKey: "e2b-key" } as const;

/** The E2B build SDK behind the real template build; `onBuild` sees each requested build. */
function buildApi(
  onBuild: (name: string, options: { cpuCount: number; memoryMB: number }) => unknown = () => {},
): E2BTemplateBuildApi {
  return {
    fromDockerfile: () => ({}) as TemplateClass,
    build: async (_template, name, options) => {
      await onBuild(name, options);
      return { alias: name, name, tags: [], templateId: "tid", buildId: "bid" };
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

test("the managed template reference is derived from the packaged Dockerfile.sandbox", async () => {
  // Distinct roots get distinct cache entries, so a temporary root cannot poison the packaged one.
  const root = await mkdtemp(join(tmpdir(), "selfbench-e2b-managed-"));
  try {
    await writeFile(join(root, "Dockerfile.sandbox"), "FROM scratch\n");
    const first = managedE2BTemplateReference(root);
    await writeFile(join(root, "Dockerfile.sandbox"), "FROM scratch\nRUN true\n");
    const second = managedE2BTemplateReference(`${root}/`);
    expect(first).toMatch(/^selfbench-runtime:[a-f0-9]{16}$/);
    expect(second).not.toBe(first);
    const other = await mkdtemp(join(tmpdir(), "selfbench-e2b-managed-"));
    try {
      await writeFile(join(other, "Dockerfile.sandbox"), "FROM scratch\nRUN false\n");
      expect(managedE2BTemplateReference(other)).not.toBe(second);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const packaged = managedE2BTemplateReference();
  expect(packaged).toMatch(/^selfbench-runtime:[a-f0-9]{16}$/);
});

test("the managed template is built only when absent, with resources matching the stage request", async () => {
  const records = new MemoryRecords();
  const builds: { name: string; cpuCount: number; memoryMB: number }[] = [];
  const api = { exists: async (reference: string) => reference === "selfbench-runtime:exists" };
  const builder = buildApi((name, options) => {
    builds.push({ name, cpuCount: options.cpuCount, memoryMB: options.memoryMB });
  });
  await ensureManagedE2BTemplate({
    reference: "selfbench-runtime:exists",
    credentials: CREDENTIALS,
    records,
    credentialId: crypto.randomUUID(),
    api,
    buildApi: builder,
  });
  expect(builds).toHaveLength(0);
  await ensureManagedE2BTemplate({
    reference: "selfbench-runtime:missing",
    credentials: CREDENTIALS,
    records,
    credentialId: crypto.randomUUID(),
    api,
    buildApi: builder,
  });
  expect(builds).toEqual([
    {
      name: "selfbench-runtime:missing",
      cpuCount: MANAGED_E2B_TEMPLATE_CPUS,
      memoryMB: MANAGED_E2B_TEMPLATE_MEMORY_MIB,
    },
  ]);
});

test("a failed build releases the lock and another attempt can rebuild", async () => {
  const records = new MemoryRecords();
  const credentialId = crypto.randomUUID();
  let fail = true;
  const options = {
    reference: "selfbench-runtime:missing",
    credentials: CREDENTIALS,
    records,
    credentialId,
    api: { exists: async () => false },
    buildApi: buildApi(() => {
      if (fail) throw new Error("control plane unavailable");
    }),
  };
  await expect(ensureManagedE2BTemplate(options)).rejects.toThrow(
    "could not be built in this account",
  );
  // The claim is released by writing our own record (a delete could wipe a successor's lock).
  expect(
    await records.read<{ status: string }>(
      managedE2BTemplateRecordPath(credentialId, "selfbench-runtime:missing"),
    ),
  ).toMatchObject({ value: { status: "failed" } });
  fail = false;
  await ensureManagedE2BTemplate(options);
  const record = await records.read<{ status: string; buildId: string }>(
    managedE2BTemplateRecordPath(credentialId, "selfbench-runtime:missing"),
  );
  expect(record?.value).toMatchObject({ status: "ready", buildId: "bid" });
});

test("a concurrent build waits for the winner instead of building a second template", async () => {
  const records = new MemoryRecords();
  const credentialId = crypto.randomUUID();
  const reference = "selfbench-runtime:missing";
  const winnerStarted = deferred();
  const releaseWinner = deferred();
  const builds: string[] = [];
  let built = false;
  const shared = {
    api: { exists: async () => built },
    buildApi: buildApi(async (name) => {
      builds.push(name);
      winnerStarted.resolve();
      await releaseWinner.promise;
      built = true;
    }),
  };
  const winner = ensureManagedE2BTemplate({
    reference,
    credentials: CREDENTIALS,
    records,
    credentialId,
    ...shared,
  });
  await winnerStarted.promise;
  const waiter = ensureManagedE2BTemplate({
    reference,
    credentials: CREDENTIALS,
    records,
    credentialId,
    ...shared,
    // Zero delay: the first poll races the winner's final record write, which the loop tolerates.
    sleep: async () => {},
  });
  releaseWinner.resolve();
  await Promise.all([winner, waiter]);
  expect(builds).toEqual([reference]);
  const record = await records.read<{ status: string }>(
    managedE2BTemplateRecordPath(credentialId, reference),
  );
  expect(record?.value.status).toBe("ready");
});

test("a build lock left by a dead worker is taken over", async () => {
  const records = new MemoryRecords();
  const credentialId = crypto.randomUUID();
  const reference = "selfbench-runtime:missing";
  const path = managedE2BTemplateRecordPath(credentialId, reference);
  let clock = 46 * 60_000;
  const builds: string[] = [];
  const api = { exists: async () => false };
  const builder = buildApi((name) => builds.push(name));
  // A lock the dead worker last refreshed long before the stale window.
  await records.write(
    path,
    { status: "building", startedAt: new Date(clock - 46 * 60_000).toISOString() },
    0,
  );
  await ensureManagedE2BTemplate({
    reference,
    credentials: CREDENTIALS,
    records,
    credentialId,
    api,
    buildApi: builder,
    now: () => clock,
  });
  expect(builds).toEqual([reference]);
  await records.destroy(path);
  // Now a lock the dead worker held until just before the stale window.
  await records.write(
    path,
    { status: "building", startedAt: new Date(clock - 60_000).toISOString() },
    0,
  );
  await ensureManagedE2BTemplate({
    reference,
    credentials: CREDENTIALS,
    records,
    credentialId,
    api,
    buildApi: builder,
    now: () => clock,
    // Each poll advances the clock past the stale window, so the waiter takes the lock over.
    sleep: () => {
      clock += 46 * 60_000;
      return Promise.resolve();
    },
  });
  expect(builds).toEqual([reference, reference]);
});

test("a live lock that outlives the deadline fails the run instead of building a second template", async () => {
  const records = new MemoryRecords();
  const credentialId = crypto.randomUUID();
  const reference = "selfbench-runtime:missing";
  const path = managedE2BTemplateRecordPath(credentialId, reference);
  await records.write(path, { status: "building", startedAt: new Date(0).toISOString() }, 0);
  let clock = 0;
  let version = 1;
  await expect(
    ensureManagedE2BTemplate({
      reference,
      credentials: CREDENTIALS,
      records,
      credentialId,
      api: { exists: async () => false },
      now: () => clock,
      // A rival keeps refreshing its build lock, so the claim always loses, until the
      // one-hour wait deadline fires.
      sleep: () => {
        clock += 15 * 60_000;
        void records
          .write(path, { status: "building", startedAt: new Date(clock).toISOString() }, version++)
          .catch(() => undefined);
        return Promise.resolve();
      },
    }),
  ).rejects.toThrow("still being built after one hour");
});

test("template record paths are namespaced by credential and cannot collide", () => {
  const credentialId = crypto.randomUUID();
  const path = managedE2BTemplateRecordPath(credentialId, "selfbench-runtime:abc");
  expect(path).toBe(`e2b-templates/${credentialId}/selfbench-runtime/abc`);
  expect(() => managedE2BTemplateRecordPath("not-a-uuid", "selfbench-runtime:abc")).toThrow(
    "Invalid credential ID",
  );
  expect(() => managedE2BTemplateRecordPath("../escape", "selfbench-runtime:abc")).toThrow(
    "Invalid credential ID",
  );
});
