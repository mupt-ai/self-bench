import { afterEach, expect, test } from "bun:test";
import { executionEnvironment } from "../../src/contracts/config/execution-environment.js";
import { loadWorkerConfig } from "../../src/contracts/config/index.js";
import { HOSTED_EXECUTION_BACKENDS } from "../../src/contracts/config/providers.js";
import { credentialSchema } from "../../src/db/credentials.js";
import { withGenerationRuntime } from "../../src/generation/pipeline/runtime.js";
import {
  type GenerationSettings,
  generationSettingsSchema,
} from "../../src/generation/settings/settings.js";
import { createSandboxExecutor } from "../../src/sandbox/index.js";
import { TimeoutCappedSandboxExecutor } from "../../src/sandbox/timeout.js";
import { memoryVault } from "../support/evaluation-vault.js";
import { prFixture, pullRequest, REPO } from "../support/pr-fixture.js";
import type { AuthServer } from "../support/site-fixture.js";

const image = `registry.example/selfbench@sha256:${"a".repeat(64)}`;
let server: AuthServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

for (const sandbox of ["e2b", "vercel"] as const) {
  for (const harborEnvironment of ["modal", "vercel", "e2b", "daytona"] as const) {
    test(`${sandbox} generation persists provider runtime and uses scoped credentials with ${harborEnvironment} verification`, async () => {
      const vault = memoryVault();
      const model = await vault.credentials.create(
        2,
        { name: "Model", kind: "openai", auth: "api-key", value: "model-secret" },
        {},
      );
      const cloud = await vault.credentials.create(
        2,
        {
          name: "Cloud",
          kind: sandbox,
          auth: "api-key",
          value: "cloud-secret",
          ...(sandbox === "vercel" ? { teamId: "team_test", projectId: "prj_test" } : {}),
        },
        {},
      );
      const modal = await vault.credentials.create(
        2,
        {
          name: "Verifier",
          kind: harborEnvironment,
          auth: "api-key",
          value: "modal-secret",
          ...(harborEnvironment === "modal" ? { tokenId: "modal-id" } : {}),
          ...(harborEnvironment === "vercel"
            ? { teamId: "team_harbor", projectId: "prj_harbor" }
            : {}),
        },
        {},
      );
      const generation: GenerationSettings = {
        authorModel: "gpt-6-sol",
        verifierModel: "gpt-6-astra",
        reasoning: "high",
        modelAccess: "credential",
        sandbox,
        modelCredentialId: model.id,
        sandboxCredentialId: cloud.id,
        sandboxImage: sandbox === "e2b" ? "selfbench-runtime:stable" : image,
        harborEnvironment,
        harborCredentialId: modal.id,
      };
      const { site, headers, started } = await prFixture({
        vault,
        pullRequests: { 57: pullRequest(57) },
      });
      server = site;
      const options = await (await site.request(`${REPO}/generation-options`, { headers })).json();
      expect(options.sandboxes).toEqual([...HOSTED_EXECUTION_BACKENDS]);
      expect(options.sandboxes).not.toContain("docker");
      const optionsJSON = JSON.stringify(options);
      for (const secret of [
        "cloud-secret",
        "modal-secret",
        "model-secret",
        "team_test",
        "prj_test",
      ])
        expect(optionsJSON).not.toContain(secret);
      const post = (value: unknown) =>
        site.request(`${REPO}/tasks/from-pr`, {
          method: "POST",
          headers,
          body: JSON.stringify({ pr: 57, generation: value }),
        });
      expect((await post({ ...generation, sandboxCredentialId: model.id })).status).toBe(400);
      // Vercel requires its digest-pinned runtime image; E2B defaults to the managed template.
      if (sandbox === "vercel")
        expect((await post({ ...generation, sandboxImage: undefined })).status).toBe(400);
      if (harborEnvironment !== sandbox)
        expect((await post({ ...generation, harborCredentialId: cloud.id })).status).toBe(400);
      expect(started).toHaveLength(0);
      expect((await post(generation)).status).toBe(201);
      const run = started[0]?.input.run;
      if (!run) throw new Error("Generation was not started");
      expect(run.version).toMatchObject({
        executionBackend: sandbox,
        harborEnvironment,
        sandboxImage: generation.sandboxImage,
        sandboxTimeoutCapMs: sandbox === "e2b" ? 3_600_000 : 7_200_000,
      });
      for (const secret of [
        "model-secret",
        "cloud-secret",
        "modal-secret",
        "team_test",
        "prj_test",
      ])
        expect(JSON.stringify(started)).not.toContain(secret);
      const config = loadWorkerConfig({});
      const legacy = createSandboxExecutor(config.execution);
      try {
        for (const stage of ["author", "verifier"] as const) {
          await withGenerationRuntime(
            config,
            vault,
            run,
            stage,
            legacy,
            async (executor, harbor, configured) => {
              expect(executor).toBeInstanceOf(TimeoutCappedSandboxExecutor);
              expect(harbor).toBe(harborEnvironment);
              expect(configured.authoring.model).toBe(
                stage === "author" ? generation.authorModel : generation.verifierModel,
              );
              const env = executionEnvironment();
              expect(env.OPENAI_API_KEY).toBe("model-secret");
              expect(env.E2B_API_KEY).toBe(sandbox === "e2b" ? "cloud-secret" : undefined);
              expect(env.VERCEL_TOKEN).toBe(sandbox === "vercel" ? "cloud-secret" : undefined);
              expect(env.VERCEL_TEAM_ID).toBe(sandbox === "vercel" ? "team_test" : undefined);
              expect(env.VERCEL_PROJECT_ID).toBe(sandbox === "vercel" ? "prj_test" : undefined);
              expect(env.MODAL_TOKEN_SECRET).toBe(
                harborEnvironment === "modal" ? "modal-secret" : undefined,
              );
              expect(env.DAYTONA_API_KEY).toBe(
                harborEnvironment === "daytona" ? "modal-secret" : undefined,
              );
              expect(env.SELFBENCH_HARBOR_E2B_API_KEY).toBe(
                harborEnvironment === "e2b" ? "modal-secret" : undefined,
              );
              expect(env.SELFBENCH_HARBOR_VERCEL_TOKEN).toBe(
                harborEnvironment === "vercel" ? "modal-secret" : undefined,
              );
              expect(env.SELFBENCH_HARBOR_VERCEL_TEAM_ID).toBe(
                harborEnvironment === "vercel" ? "team_harbor" : undefined,
              );
            },
          );
        }
        const tampered = { ...run, version: { ...run.version, sandboxImage: "other-runtime" } };
        await expect(
          withGenerationRuntime(config, vault, tampered, "author", legacy, async () => {
            throw new Error("must not run");
          }),
        ).rejects.toThrow("saved configuration");
        await vault.credentials.remove(2, cloud.id);
        await expect(
          withGenerationRuntime(config, vault, run, "author", legacy, async () => {
            throw new Error("must not run");
          }),
        ).rejects.toThrow("credential from your account");
      } finally {
        legacy.close();
      }
      expect(executionEnvironment()).toBe(process.env);
    });
  }
}

test("cloud generation validates runtime artifacts and never offers worker-local Docker", () => {
  const base = {
    authorModel: "gpt-6-sol",
    verifierModel: "gpt-6-astra",
    reasoning: "high",
    modelAccess: "credential",
    sandbox: "modal",
    modelCredentialId: crypto.randomUUID(),
    sandboxCredentialId: crypto.randomUUID(),
    harborEnvironment: "modal",
    harborCredentialId: crypto.randomUUID(),
  };
  expect(generationSettingsSchema.safeParse(base).success).toBe(true);
  expect(generationSettingsSchema.safeParse({ ...base, sandbox: "docker" }).success).toBe(false);
  expect(
    generationSettingsSchema.safeParse({ ...base, sandboxCredentialId: undefined }).success,
  ).toBe(false);
  const cloud = {
    ...base,
    sandbox: "e2b",
    harborEnvironment: "modal",
    harborCredentialId: crypto.randomUUID(),
    sandboxImage: "team/selfbench:stable",
  };
  expect(generationSettingsSchema.safeParse(cloud).success).toBe(true);
  for (const sandboxImage of ["", "base", "base:latest", "invalid image", "https://example.com"])
    expect(generationSettingsSchema.safeParse({ ...cloud, sandboxImage }).success).toBe(false);
  // Without an override the worker builds the managed template in the account.
  expect(generationSettingsSchema.safeParse({ ...cloud, sandboxImage: undefined }).success).toBe(
    true,
  );
  expect(
    generationSettingsSchema.safeParse({ ...cloud, sandbox: "vercel", sandboxImage: image })
      .success,
  ).toBe(true);
  expect(
    generationSettingsSchema.safeParse({ ...cloud, sandbox: "vercel", sandboxImage: "node:22" })
      .success,
  ).toBe(false);
  expect(
    generationSettingsSchema.safeParse({ ...cloud, harborEnvironment: "runloop" }).success,
  ).toBe(false);
  expect(
    generationSettingsSchema.safeParse({ ...cloud, harborEnvironment: "docker" }).success,
  ).toBe(false);
  for (const harborEnvironment of ["vercel", "e2b", "daytona"])
    expect(generationSettingsSchema.safeParse({ ...cloud, harborEnvironment }).success).toBe(true);
  expect(
    generationSettingsSchema.safeParse({ ...cloud, harborEnvironment: undefined }).success,
  ).toBe(false);
  expect(
    generationSettingsSchema.safeParse({ ...cloud, harborCredentialId: undefined }).success,
  ).toBe(false);
  expect(generationSettingsSchema.safeParse({ ...base, sandboxImage: "ignored" }).success).toBe(
    false,
  );
});

test("Vercel credential fields are required, provider-specific, and never listed", async () => {
  const draft = {
    name: "Vercel",
    kind: "vercel" as const,
    auth: "api-key" as const,
    value: "token-secret",
    teamId: "team_one",
    projectId: "prj_one",
  };
  expect(credentialSchema.safeParse(draft).success).toBe(true);
  for (const invalid of [
    { ...draft, teamId: undefined },
    { ...draft, projectId: "" },
    { ...draft, teamId: "one\ntwo" },
    { ...draft, kind: "e2b" },
    { ...draft, tokenId: "modal-token" },
  ])
    expect(credentialSchema.safeParse(invalid).success).toBe(false);
  const vault = memoryVault();
  const saved = await vault.credentials.create(7, draft, {});
  const stored = await vault.credentials.secret(7, saved.id);
  expect(stored).toEqual({ value: "token-secret", teamId: "team_one", projectId: "prj_one" });
  const listed = JSON.stringify(await vault.credentials.list(7));
  for (const privateValue of ["token-secret", "team_one", "prj_one"])
    expect(listed).not.toContain(privateValue);
});
