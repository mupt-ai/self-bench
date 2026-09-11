import { expect, test } from "bun:test";
import { loadWorkerConfig } from "../src/config.js";
import { saveCredential } from "../src/evaluation/credentials.js";
import { orgRecords } from "../src/evaluation/org-records.js";
import { createSandboxExecutor } from "../src/sandbox/index.js";
import { generationEnvironment } from "../src/site/generation-credentials.js";
import { createActivities } from "../src/temporal/activities/factory.js";
import { withGenerationRuntime } from "../src/temporal/activities/generation-runtime.js";
import { fixture, ROOT } from "./support/batch-fixture.js";
import { MemoryRecords } from "./support/evaluation-records.js";

async function configured() {
  const records = new MemoryRecords();
  const f = await fixture({ records });
  const model = await saveCredential(
    orgRecords(records, f.tenant.id),
    f.tenant.id,
    { name: "Model", kind: "openai", auth: "api-key", value: "batch-model-secret" },
    {},
  );
  const sandbox = await saveCredential(
    orgRecords(records, f.tenant.id),
    f.tenant.id,
    {
      name: "Sandbox",
      kind: "modal",
      auth: "api-key",
      value: "batch-modal-secret",
      tokenId: "batch-token",
    },
    {},
  );
  const generation = {
    authorModel: "gpt-6-astra",
    verifierModel: "gpt-5.6-luna",
    reasoning: "low",
    sandbox: "modal",
    modelCredentialId: model.id,
    sandboxCredentialId: sandbox.id,
  } as const;
  const post = (settings: unknown = generation) =>
    f.request(ROOT, {
      method: "POST",
      body: JSON.stringify({
        candidateCounts: { easy: 1, medium: 0, hard: 1 },
        generation: settings,
      }),
    });
  return { ...f, records, generation, post };
}

test("batch settings reach discovery and candidate runtimes with saved organization credentials", async () => {
  const f = await configured();
  expect((await f.post()).status).toBe(202);
  const run = f.started[0];
  if (!run?.generation) throw new Error("missing configured run");
  expect(run).toMatchObject({
    authoring: { provider: "openai", model: "gpt-6-astra", reasoningEffort: "low" },
    version: {
      executionBackend: "modal",
      harborEnvironment: "modal",
      sandboxImage: "node:22-bookworm",
    },
    generation: {
      ownerId: f.tenant.id,
      orgId: f.tenant.id,
      repoId: f.repo.id,
      settings: f.generation,
    },
  });
  expect(JSON.stringify(run)).not.toContain("batch-model-secret");
  expect(JSON.stringify(run)).not.toContain("batch-modal-secret");
  const env = await generationEnvironment(f.records, run.runId, run.generation, {});
  expect(env.OPENAI_API_KEY).toBe("batch-model-secret");
  expect(env.MODAL_TOKEN_SECRET).toBe("batch-modal-secret");
  const config = loadWorkerConfig({});
  const legacy = createSandboxExecutor(config.execution);
  for (const stage of ["author", "verifier"] as const) {
    await withGenerationRuntime(
      config,
      f.records,
      run,
      stage,
      legacy,
      async (sandbox, environment, configured) => {
        expect(sandbox.constructor.name).toBe("ModalSandboxExecutor");
        expect(environment).toBe("modal");
        expect(configured.authoring.model).toBe(
          stage === "author" ? "gpt-6-astra" : "gpt-5.6-luna",
        );
        expect(configured.authoring.reasoningEffort).toBe("low");
      },
    );
  }
  // Discovery must resolve this run's credentials before touching any sandbox or activity context.
  const activities = createActivities(config);
  await expect(
    activities.discoverCandidateShard({
      run,
      wave: 0,
      shardIndex: 0,
      shardCount: 1,
      targetCounts: run.candidateCounts,
      excludedSourcePrs: [],
    }),
  ).rejects.toThrow("credentials are not configured");
  const dockerSettings = { ...f.generation, sandbox: "docker", sandboxCredentialId: undefined };
  expect((await f.post(dockerSettings)).status).toBe(202);
  const dockerRun = f.started[1];
  if (!dockerRun?.generation) throw new Error("missing Docker run");
  expect(dockerRun.version.executionBackend).toBe("docker");
  const dockerEnv = await generationEnvironment(f.records, dockerRun.runId, dockerRun.generation, {
    MODAL_TOKEN_ID: "host",
    MODAL_TOKEN_SECRET: "host",
  });
  expect(dockerEnv.MODAL_TOKEN_SECRET).toBeUndefined();
  await withGenerationRuntime(
    config,
    f.records,
    dockerRun,
    "author",
    legacy,
    async (sandbox, environment) => {
      expect(sandbox.constructor.name).toBe("DockerSandboxExecutor");
      expect(environment).toBe("docker");
    },
  );
});

test("invalid, foreign and missing batch credentials fail before discovery or workflow start", async () => {
  const f = await configured();
  const foreign = await saveCredential(
    orgRecords(f.records, f.tenant.id + 100),
    f.tenant.id + 100,
    { name: "Foreign", kind: "openai", auth: "api-key", value: "foreign" },
    {},
  );
  for (const settings of [
    { ...f.generation, modelCredentialId: foreign.id },
    { ...f.generation, sandboxCredentialId: foreign.id },
    { ...f.generation, sandboxCredentialId: undefined },
    { ...f.generation, authorModel: "unsupported" },
    { ...f.generation, reasoning: "invalid" },
    { ...f.generation, sandbox: "unsupported" },
    { ...f.generation, modelCredentialId: "" },
  ])
    expect((await f.post(settings)).status).toBe(400);
  expect(f.github).toHaveLength(0);
  expect(f.started).toHaveLength(0);
  expect(await f.runs.runsFor(f.repo.id)).toHaveLength(0);
  const unavailable = await fixture();
  expect(
    (
      await unavailable.request(ROOT, {
        method: "POST",
        body: JSON.stringify({
          candidateCounts: { easy: 1, medium: 0, hard: 0 },
          generation: f.generation,
        }),
      })
    ).status,
  ).toBe(503);
  expect(unavailable.github).toHaveLength(0);
  expect(unavailable.started).toHaveLength(0);
  f.records.write = async () => {
    throw new Error("storage unavailable");
  };
  expect((await f.post()).status).toBe(500);
  expect(f.started).toHaveLength(0);
});
