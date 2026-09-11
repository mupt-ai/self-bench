import { expect, test } from "bun:test";
import { loadWorkerConfig } from "../src/config.js";
import type { RunRequest } from "../src/contracts.js";
import { saveCredential } from "../src/evaluation/credentials.js";
import { orgRecords } from "../src/evaluation/org-records.js";
import { executionEnvironment } from "../src/execution-environment.js";
import { createSandboxExecutor } from "../src/sandbox/index.js";
import { generationEnvironment } from "../src/site/generation-credentials.js";
import { generationSettingsSchema } from "../src/site/generation-settings.js";
import { loadPiModelAuth } from "../src/subscription-auth.js";
import { withGenerationRuntime } from "../src/temporal/activities/generation-runtime.js";
import { fixture, ROOT } from "./support/batch-fixture.js";
import { codexAuth } from "./support/codex-auth.js";
import { MemoryRecords } from "./support/evaluation-records.js";
import { prFixture, pullRequest, REPO } from "./support/pr-fixture.js";

test.each(["batch", "pr"] as const)(
  "%s generation carries E2B credentials and pins its template while Harbor uses Docker",
  async (kind) => {
    const previous = process.env.SELFBENCH_E2B_TEMPLATE;
    process.env.SELFBENCH_E2B_TEMPLATE = "selfbench-test";
    const records = new MemoryRecords();
    let close: (() => Promise<void>) | undefined;
    try {
      let ownerId: number;
      let submit: (settings: unknown) => Promise<Response>;
      let submitted: () => RunRequest | undefined;
      if (kind === "batch") {
        const f = await fixture({ records });
        ownerId = f.tenant.id;
        submit = (generation) =>
          f.request(ROOT, {
            method: "POST",
            body: JSON.stringify({ candidateCounts: { easy: 1, medium: 0, hard: 0 }, generation }),
          });
        submitted = () => f.started[0];
      } else {
        const f = await prFixture({ records, pullRequests: { 57: pullRequest(57) } });
        close = () => f.site.stop();
        ownerId = 2;
        submit = (generation) =>
          f.site.request(`${REPO}/tasks/from-pr`, {
            method: "POST",
            headers: f.headers,
            body: JSON.stringify({ pr: 57, generation }),
          });
        submitted = () => f.started[0]?.input.run;
        const options = await (
          await f.site.request(`${REPO}/generation-options`, { headers: f.headers })
        ).json();
        expect(options.sandboxes).toContain("e2b");
      }
      const scoped = orgRecords(records, ownerId);
      const model = await saveCredential(
        scoped,
        ownerId,
        { name: "ChatGPT", kind: "openai", auth: "codex-login", value: codexAuth },
        {},
      );
      const e2b = await saveCredential(
        scoped,
        ownerId,
        { name: "E2B", kind: "e2b", auth: "api-key", value: "selected-e2b-secret" },
        {},
      );
      const modal = await saveCredential(
        scoped,
        ownerId,
        {
          name: "Modal",
          kind: "modal",
          auth: "api-key",
          value: "modal-secret",
          tokenId: "modal-id",
        },
        {},
      );
      const foreign = await saveCredential(
        orgRecords(records, ownerId + 100),
        ownerId + 100,
        { name: "Foreign", kind: "e2b", auth: "api-key", value: "foreign-key" },
        {},
      );
      const settings = {
        authorModel: "gpt-5.6-sol",
        verifierModel: "gpt-6-astra",
        reasoning: "high",
        sandbox: "e2b",
        sandboxImage: "selfbench-test",
        harborEnvironment: "docker",
        modelCredentialId: model.id,
        sandboxCredentialId: e2b.id,
      };
      expect(
        generationSettingsSchema.safeParse({ ...settings, sandboxCredentialId: undefined }).success,
      ).toBe(false);
      for (const id of [modal.id, foreign.id, model.id])
        expect((await submit({ ...settings, sandboxCredentialId: id })).status).toBe(400);
      expect(submitted()).toBeUndefined();
      expect((await submit(settings)).status).toBe(kind === "batch" ? 202 : 201);
      const run = submitted();
      if (!run?.generation) throw new Error("Missing generation");
      expect(run.version).toMatchObject({
        executionBackend: "e2b",
        harborEnvironment: "docker",
        sandboxImage: "selfbench-test",
        sandboxTimeoutCapMs: 3600000,
      });
      expect(JSON.stringify(run)).not.toContain("selected-e2b-secret");
      expect(JSON.stringify(run)).not.toContain("test-refresh");
      const env = await generationEnvironment(records, run.runId, run.generation, {
        E2B_API_KEY: "host-key",
        E2B_DOMAIN: "untrusted.example",
        MODAL_TOKEN_ID: "host-modal",
        MODAL_TOKEN_SECRET: "host-secret",
      });
      expect(env.E2B_API_KEY).toBe("selected-e2b-secret");
      expect(env.E2B_DOMAIN).toBeUndefined();
      expect(env.MODAL_TOKEN_SECRET).toBeUndefined();
      process.env.SELFBENCH_E2B_TEMPLATE = "changed-host-template";
      const config = loadWorkerConfig({});
      for (const stage of ["author", "verifier"] as const) {
        await withGenerationRuntime(
          config,
          records,
          run,
          stage,
          createSandboxExecutor(config.execution),
          async (sandbox, harbor, configured) => {
            expect(sandbox.constructor.name).toBe("TimeoutCappedSandboxExecutor");
            expect(harbor).toBe("docker");
            expect(configured.version.sandboxImage).toBe("selfbench-test");
            expect(executionEnvironment().E2B_API_KEY).toBe("selected-e2b-secret");
            expect((await loadPiModelAuth()).provider).toBe("openai-codex");
          },
        );
      }
    } finally {
      await close?.();
      if (previous === undefined) delete process.env.SELFBENCH_E2B_TEMPLATE;
      else process.env.SELFBENCH_E2B_TEMPLATE = previous;
    }
  },
);
