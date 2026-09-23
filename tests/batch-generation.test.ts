import { expect, test } from "bun:test";
import { withExecutionEnvironment } from "../src/contracts/config/execution-environment.js";
import { loadWorkerConfig } from "../src/contracts/config/index.js";
import { createActivities } from "../src/generation/pipeline/activities.js";
import { withGenerationRuntime } from "../src/generation/pipeline/runtime.js";
import { generationEnvironment } from "../src/generation/settings/credentials.js";
import { createSandboxExecutor } from "../src/sandbox/index.js";
import { githubToken } from "../src/third_party/github/token.js";
import { fixture, ROOT } from "./support/batch-fixture.js";
import { memoryVault } from "./support/evaluation-vault.js";

async function configured() {
  const vault = memoryVault();
  const f = await fixture({ vault });
  const model = await vault.credentials.create(
    f.tenant.id,
    { name: "Model", kind: "openai", auth: "api-key", value: "batch-model-secret" },
    {},
  );
  const sandbox = await vault.credentials.create(
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
    verifierModel: "gpt-5.6-sol",
    reasoning: "low",
    modelAccess: "credential",
    sandbox: "modal",
    modelCredentialId: model.id,
    sandboxCredentialId: sandbox.id,
    harborEnvironment: "modal",
    harborCredentialId: sandbox.id,
  } as const;
  const post = (settings: unknown = generation) =>
    f.request(ROOT, {
      method: "POST",
      body: JSON.stringify({
        candidateCounts: { easy: 1, medium: 0, hard: 1 },
        generation: settings,
      }),
    });
  return { ...f, vault, generation, post };
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
  expect(JSON.stringify(run)).not.toContain("secret-token");
  const env = await generationEnvironment(f.vault, run.runId, run.generation, {});
  expect(env.OPENAI_API_KEY).toBe("batch-model-secret");
  expect(env.MODAL_TOKEN_SECRET).toBe("batch-modal-secret");
  // The hosted worker has no GitHub login; provenance and discovery use the submitter's token.
  expect(env.GH_TOKEN).toBe("secret-token");
  await withExecutionEnvironment(env, async () => expect(await githubToken()).toBe("secret-token"));
  const config = loadWorkerConfig({});
  const legacy = createSandboxExecutor(config.execution);
  for (const stage of ["author", "verifier"] as const) {
    await withGenerationRuntime(
      config,
      f.vault,
      run,
      stage,
      legacy,
      async (sandbox, environment, configured) => {
        expect(sandbox.constructor.name).toBe("ModalSandboxExecutor");
        expect(environment).toBe("modal");
        expect(configured.authoring.model).toBe(stage === "author" ? "gpt-6-astra" : "gpt-5.6-sol");
        expect(configured.authoring.reasoningEffort).toBe("low");
      },
    );
  }
  // Discovery must resolve this run's credentials before touching any sandbox
  // or activity context.
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
  // Docker would run every sandbox on the shared worker, so the site never accepts it.
  const dockerSettings = { ...f.generation, sandbox: "docker", sandboxCredentialId: undefined };
  expect((await f.post(dockerSettings)).status).toBe(400);
  expect(f.started).toHaveLength(1);
});

test("invalid, foreign and missing batch credentials fail before discovery or workflow start", async () => {
  const f = await configured();
  const foreign = await f.vault.credentials.create(
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
  f.vault.records.write = async () => {
    throw new Error("storage unavailable");
  };
  expect((await f.post()).status).toBe(500);
  expect(f.started).toHaveLength(0);
}, 15_000);
