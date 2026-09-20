import { afterEach, expect, test } from "bun:test";
import { loadWorkerConfig } from "../src/config.js";
import { secretPath } from "../src/evaluation/account.js";
import {
  credentialSchema,
  listCredentials,
  saveCredential,
} from "../src/evaluation/credentials.js";
import { orgRecords } from "../src/evaluation/org-records.js";
import { executionEnvironment } from "../src/execution-environment.js";
import { harborChildEnvironment } from "../src/harbor-environment.js";
import { HOSTED_EXECUTION_BACKENDS } from "../src/providers.js";
import { createSandboxExecutor } from "../src/sandbox/index.js";
import {
  HOBBY_E2B_TIMEOUT_CAP_MS,
  STANDARD_VERCEL_TIMEOUT_CAP_MS,
} from "../src/sandbox/timeout.js";
import {
  type GenerationSettings,
  generationSettingsSchema,
} from "../src/site/generation-settings.js";
import { withGenerationRuntime } from "../src/temporal/activities/generation-runtime.js";
import { MemoryRecords } from "./support/evaluation-records.js";
import { prFixture, pullRequest, REPO } from "./support/pr-fixture.js";
import type { AuthServer } from "./support/site-fixture.js";

const image = `registry.example/selfbench@sha256:${"a".repeat(64)}`;
let server: AuthServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

for (const sandbox of ["e2b", "vercel"] as const) {
  for (const harborEnvironment of ["modal", "vercel", "e2b", "daytona"] as const) {
    test(`${sandbox} generation persists provider runtime and uses scoped credentials with ${harborEnvironment} verification`, async () => {
      const records = new MemoryRecords();
      const scoped = orgRecords(records, 2);
      const model = await saveCredential(
        scoped,
        2,
        { name: "Model", kind: "openai", auth: "api-key", value: "model-secret" },
        {},
      );
      const cloud = await saveCredential(
        scoped,
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
      const modal = await saveCredential(
        scoped,
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
        authorModel: "gpt-5.6-sol",
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
        records,
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
      expect((await post({ ...generation, harborEnvironment: undefined })).status).toBe(400);
      // Docker generation and Docker Harbor would run on the worker; the site rejects both.
      expect((await post({ ...generation, sandbox: "docker" })).status).toBe(400);
      expect((await post({ ...generation, harborEnvironment: "docker" })).status).toBe(400);
      expect((await post({ ...generation, harborCredentialId: undefined })).status).toBe(400);
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
        sandboxTimeoutCapMs:
          sandbox === "e2b" ? HOBBY_E2B_TIMEOUT_CAP_MS : STANDARD_VERCEL_TIMEOUT_CAP_MS,
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
            records,
            run,
            stage,
            legacy,
            async (executor, harbor, configured) => {
              expect(executor.constructor.name).toBe("TimeoutCappedSandboxExecutor");
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
              expect(harborChildEnvironment(env, harbor).E2B_API_KEY).toBe(
                harborEnvironment === "e2b" ? "modal-secret" : undefined,
              );
              expect(env.SELFBENCH_HARBOR_VERCEL_TOKEN).toBe(
                harborEnvironment === "vercel" ? "modal-secret" : undefined,
              );
              const harborChild = harborChildEnvironment(env, harbor);
              expect(harborChild.VERCEL_TOKEN).toBe(
                harborEnvironment === "vercel" ? "modal-secret" : undefined,
              );
              expect(harborChild.VERCEL_TEAM_ID).toBe(
                harborEnvironment === "vercel" ? "team_harbor" : undefined,
              );
              expect(harborChild.SELFBENCH_HARBOR_VERCEL_TOKEN).toBeUndefined();
            },
          );
        }
        const tampered = { ...run, version: { ...run.version, sandboxImage: "other-runtime" } };
        await expect(
          withGenerationRuntime(config, records, tampered, "author", legacy, async () => {
            throw new Error("must not run");
          }),
        ).rejects.toThrow("saved configuration");
        await scoped.destroy(secretPath(2, cloud.id));
        await expect(
          withGenerationRuntime(config, records, run, "author", legacy, async () => {
            throw new Error("must not run");
          }),
        ).rejects.toThrow("credential is unavailable");
      } finally {
        legacy.close();
      }
      expect(executionEnvironment()).toBe(process.env);
    });
  }
}

test("cloud generation validates runtime artifacts and never offers worker-local Docker", () => {
  const base = {
    authorModel: "gpt-5.6-sol",
    verifierModel: "gpt-6-astra",
    reasoning: "high",
    modelAccess: "credential",
    sandbox: "modal",
    modelCredentialId: crypto.randomUUID(),
    sandboxCredentialId: crypto.randomUUID(),
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
  const records = new MemoryRecords();
  const saved = await saveCredential(records, 7, draft, {});
  const stored = (await records.read(secretPath(7, saved.id)))?.value;
  expect(stored).toEqual({ value: "token-secret", teamId: "team_one", projectId: "prj_one" });
  const listed = JSON.stringify(await listCredentials(records, 7));
  for (const privateValue of ["token-secret", "team_one", "prj_one"])
    expect(listed).not.toContain(privateValue);
});
