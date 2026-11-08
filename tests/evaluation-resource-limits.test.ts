import { expect, test } from "bun:test";
import { runCommand } from "../src/lib/process.js";
import { evaluationServer } from "./support/evaluation-fixture.js";
import { memoryVault } from "./support/evaluation-vault.js";
import { fakeHarbor, harborTaskToml, publishedTask } from "./support/harbor-registry.js";

const heavy = publishedTask(
  "heavy/build",
  { "task.toml": harborTaskToml("heavy/build", 'cpus = 16\nmemory = "32G"\n') },
  "4".repeat(64),
);

test("a sandbox credential's resource limits refuse tasks over them before anything runs", async () => {
  const harbor = fakeHarbor({ "heavy/dataset@latest": [heavy] }, runCommand);
  const inferred: string[] = [];
  const fixture = await evaluationServer(memoryVault(), {
    registryCommand: harbor.command,
    inferResourceLimits: async (kind) => {
      inferred.push(kind);
      return kind === "daytona"
        ? { limits: { cpus: 4, memoryMb: 8192 }, source: "test" }
        : { source: "test" };
    },
  });
  const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
  try {
    const create = async (body: Record<string, unknown>) => {
      const response = await fixture.request("/api/orgs/avyay/credentials", post(body));
      expect(response.status).toBe(201);
      return await response.json();
    };
    // A new sandbox account starts with the limits its provider shares; typed ones are kept.
    expect((await create({ name: "d", kind: "daytona", value: "k" })).resourceLimits).toEqual({
      cpus: 4,
      memoryMb: 8192,
    });
    const sandbox = await create({
      name: "e2b",
      kind: "e2b",
      value: "k",
      resourceLimits: { cpus: 8, memoryMb: 16384 },
    });
    expect(sandbox.resourceLimits).toEqual({ cpus: 8, memoryMb: 16384 });
    expect(inferred).toEqual(["daytona"]);
    expect(
      (
        await fixture.request(
          "/api/orgs/avyay/credentials",
          post({ name: "m", kind: "openai", value: "k", resourceLimits: { cpus: 1 } }),
        )
      ).status,
    ).toBe(400);
    const model = await create({ name: "openai", kind: "openai", value: "k" });

    await fixture.request(fixture.benchmarks, post({ reference: "heavy/dataset" }));
    const base = `${fixture.benchmarks}/heavy/dataset/evaluations`;
    const comparison = () =>
      fixture.request(
        `${base}/comparisons`,
        post({
          id: crypto.randomUUID(),
          models: [{ catalogId: "gpt-6-sol", credentialId: model.id, harnesses: ["codex"] }],
          sandbox: "e2b",
          sandboxCredentialId: sandbox.id,
        }),
      );
    const refused = await comparison();
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toContain(
      "heavy/build asks for 16 CPUs; the limit is 8, asks for 32 GiB memory; the limit is 16 GiB",
    );
    expect(fixture.starts).toHaveLength(0);

    // Raised to just above the request, it runs, with a warning that it leaves little room.
    const update = await fixture.request(
      `/api/orgs/avyay/credentials/${sandbox.id}/update`,
      post({ resourceLimits: { cpus: 17, memoryMb: 65536 } }),
    );
    expect((await update.json()).resourceLimits).toEqual({ cpus: 17, memoryMb: 65536 });
    const accepted = await comparison();
    expect(accepted.status).toBe(202);
    expect((await accepted.json()).resourceWarnings).toEqual([
      "heavy/build asks for 16 CPUs, close to the limit of 17",
    ]);
    expect(fixture.starts[0]?.tasks[0]?.resources).toEqual({ cpus: 16, memoryMb: 32768 });

    // Cleared, nothing is checked.
    const cleared = await fixture.request(
      `/api/orgs/avyay/credentials/${sandbox.id}/update`,
      post({ resourceLimits: null }),
    );
    expect((await cleared.json()).resourceLimits).toBeUndefined();
    const inference = await fixture.request(
      `/api/orgs/avyay/credentials/${sandbox.id}/infer-limits`,
      post({}),
    );
    expect(await inference.json()).toEqual({ source: "test" });
  } finally {
    await fixture.close();
  }
});
