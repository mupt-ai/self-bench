import { afterEach, describe, expect, test } from "bun:test";
import { loadWorkerConfig } from "../src/config.js";
import { tasks as taskRows } from "../src/db/schema.js";
import { saveCredential } from "../src/evaluation/credentials.js";
import { orgRecords } from "../src/evaluation/org-records.js";
import { createSandboxExecutor } from "../src/sandbox/index.js";
import { createTaskStore } from "../src/site/task-store.js";
import { loadPiModelAuth } from "../src/subscription-auth.js";
import { withGenerationRuntime } from "../src/temporal/activities/generation-runtime.js";
import { MemoryRecords } from "./support/evaluation-records.js";
import { prFixture, pullRequest, REPO } from "./support/pr-fixture.js";
import type { AuthServer } from "./support/site-fixture.js";

let server: AuthServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});
async function boot(options: Parameters<typeof prFixture>[0]) {
  const result = await prFixture(options);
  server = result.site;
  return result;
}

describe("generation submissions", () => {
  test("generation settings are scoped, validated and persisted without secrets in workflows", async () => {
    const records = new MemoryRecords();
    const model = await saveCredential(
      orgRecords(records, 2),
      2,
      { name: "Test Model", kind: "openai", auth: "api-key", value: "mock-model-secret" },
      {},
    );
    const sandbox = await saveCredential(
      orgRecords(records, 2),
      2,
      {
        name: "Test Modal",
        kind: "modal",
        auth: "api-key",
        value: "mock-sandbox-secret",
        tokenId: "mock-token-id",
      },
      {},
    );
    const foreign = await saveCredential(
      records,
      2,
      { name: "Other", kind: "openai", auth: "api-key", value: "foreign-secret" },
      {},
    );
    const { site, headers, started } = await boot({
      records,
      pullRequests: { 57: pullRequest(57) },
    });
    const generation = {
      authorModel: "gpt-6-astra",
      verifierModel: "gpt-5.6-sol",
      reasoning: "medium",
      sandbox: "modal",
      modelCredentialId: model.id,
      sandboxCredentialId: sandbox.id,
    };
    const options = await (await site.request(`${REPO}/generation-options`, { headers })).json();
    expect(options.available).toBe(true);
    expect(options.credentials.map((item: { id: string }) => item.id)).toEqual([
      model.id,
      sandbox.id,
    ]);
    const post = (settings: unknown, path = REPO) =>
      site.request(`${path}/tasks/from-pr`, {
        method: "POST",
        headers,
        body: JSON.stringify({ pr: 57, generation: settings }),
      });
    expect((await post({ ...generation, modelCredentialId: foreign.id })).status).toBe(400);
    expect((await post({ ...generation, sandbox: "unavailable" })).status).toBe(400);
    expect((await post(generation, REPO.replace("orgs/mupt-ai", "orgs/other"))).status).toBe(404);
    expect(started).toHaveLength(0);
    expect((await post(generation)).status).toBe(201);
    expect(started[0]?.input.run).toMatchObject({
      authoring: { model: "gpt-6-astra", reasoningEffort: "medium" },
      version: { executionBackend: "modal", harborEnvironment: "modal" },
      generation: { ownerId: 2, orgId: 2, settings: generation },
    });
    expect(JSON.stringify(started)).not.toContain("mock-model-secret");
    expect(JSON.stringify(started)).not.toContain("mock-sandbox-secret");
    expect((await records.read(`generations/${started[0]?.input.run.runId}`))?.value).toMatchObject(
      { settings: generation },
    );
    const run = started[0]?.input.run;
    if (!run) throw new Error("Missing submitted run");
    const config = loadWorkerConfig({});
    const legacy = createSandboxExecutor(config.execution);
    for (const stage of ["author", "verifier"] as const) {
      await withGenerationRuntime(
        config,
        records,
        run,
        stage,
        legacy,
        async (sandbox, environment, configured) => {
          expect(environment).toBe("modal");
          expect(sandbox.constructor.name).toBe("ModalSandboxExecutor");
          expect(configured.authoring.model).toBe(
            stage === "author" ? generation.authorModel : generation.verifierModel,
          );
          expect(configured.authoring.reasoningEffort).toBe("medium");
          expect((await loadPiModelAuth()).apiKey).toBe("mock-model-secret");
        },
      );
    }
    await expect(
      withGenerationRuntime(config, undefined, run, "author", legacy, async () => {
        throw new Error("Must not execute without credentials");
      }),
    ).rejects.toThrow("not configured");
  });
  test("deleted PR attempts and simultaneous submissions reserve distinct runs without overwriting history", async () => {
    const { site, headers, started, artifacts } = await boot({
      pullRequests: { 57: pullRequest(57) },
    });
    const post = () =>
      site.request(`${REPO}/tasks/from-pr`, {
        method: "POST",
        headers,
        body: JSON.stringify({ pr: 57 }),
      });
    expect((await post()).status).toBe(201);
    const [original] = await site.db.select().from(taskRows);
    if (!original) throw new Error("Missing initial attempt");
    const store = createTaskStore(site.db);
    await store.progress(original.id, { stage: "failed", pipelineStatus: "infrastructure_failed" });
    expect(await store.deleteTask(original.repoId, original.runId, original.candidateId)).toBe(
      "deleted",
    );
    const reference = started[0]?.input.run.provenance;
    if (!reference) throw new Error("Missing provenance");
    const provenance = await artifacts.get(reference);
    const responses = await Promise.all([post(), post(), post()]);
    expect(responses.map((response) => response.status)).toEqual([201, 201, 201]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    expect(bodies.map((body) => body.task.runId).sort()).toEqual(
      [2, 3, 4].map((attempt) => `${original.runId}-a${attempt}`),
    );
    expect(new Set(started.map((item) => item.workflowId)).size).toBe(4);
    const history = await site.db.select().from(taskRows);
    expect(history).toHaveLength(4);
    expect(history.find((row) => row.id === original.id)?.deletedAt).not.toBeNull();
    expect(await store.listForRepo(original.repoId)).toHaveLength(3);
    expect(await artifacts.get(reference)).toEqual(provenance);
  });
});
