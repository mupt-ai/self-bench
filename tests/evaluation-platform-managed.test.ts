import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialExecution } from "../src/evaluation/execution.js";
import { evaluationEnv, evaluationServer } from "./support/evaluation-fixture.js";
import { memoryVault } from "./support/evaluation-vault.js";

const post = (value: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(value) });

test("managed evaluations use the platform model and sandbox credentials", async () => {
  const records = memoryVault();
  const env = {
    ...evaluationEnv,
    SELFBENCH_MANAGED_OFFERING: "true",
    SELFBENCH_MANAGED_OPENROUTER_API_KEY: "managed-model-secret",
    SELFBENCH_MANAGED_E2B_API_KEY: "managed-sandbox-secret",
    SELFBENCH_MANAGED_MODAL_TOKEN_ID: "managed-modal-id",
    SELFBENCH_MANAGED_MODAL_TOKEN_SECRET: "managed-modal-secret",
    SELFBENCH_MANAGED_MODAL_ENVIRONMENT: "selfbench-test",
  };
  const fixture = await evaluationServer(records, {}, env);
  const home = await mkdtemp(join(tmpdir(), "managed-evaluation-"));
  try {
    const catalog = await (await fixture.request(`${fixture.base}/catalog`)).json();
    expect(catalog.managed).toEqual({ models: true, sandbox: true });
    const draft = {
      id: crypto.randomUUID(),
      tasks: [{ runId: "run-one", taskId: "task-one" }],
      models: [
        {
          catalogId: "gpt-6-sol",
          credentialId: "managed-model",
          harnesses: ["pi"],
          thinking: "high",
        },
      ],
      sandbox: "managed",
      sandboxCredentialId: "managed-sandbox",
    };
    expect((await fixture.request(`${fixture.base}/comparisons`, post(draft))).status).toBe(202);
    const input = fixture.starts[0];
    if (!input) throw new Error("Missing managed evaluation input");
    expect(
      (
        await fixture.request(
          `${fixture.base}/comparisons`,
          post({
            ...draft,
            id: crypto.randomUUID(),
            sandboxCredentialId: crypto.randomUUID(),
          }),
        )
      ).status,
    ).toBe(400);
    expect(fixture.starts).toHaveLength(1);
    expect(input.sandbox).toBe("modal");
    expect(input.explainFailures).toBe(true);
    const execution = await credentialExecution(input, home, env, records, "pi");
    // Managed model calls go through the gateway, which holds the platform's key itself.
    expect(execution.route).toBe("gateway");
    expect(execution.credential.id).toBe("managed-model");
    expect(JSON.stringify(execution.child)).not.toContain("managed-model-secret");
    expect(execution.child.MODAL_TOKEN_ID).toBe("managed-modal-id");
    expect(execution.child.MODAL_TOKEN_SECRET).toBe("managed-modal-secret");
    expect(execution.child.MODAL_ENVIRONMENT).toBe("selfbench-test");
    expect(execution.child.E2B_API_KEY).toBeUndefined();
    expect(execution.secrets).toContain("managed-modal-secret");
  } finally {
    await fixture.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("managed evaluation requires Modal even when managed E2B is configured", async () => {
  const fixture = await evaluationServer(
    memoryVault(),
    {},
    {
      ...evaluationEnv,
      SELFBENCH_MANAGED_OFFERING: "true",
      SELFBENCH_MANAGED_E2B_API_KEY: "managed-e2b",
    },
  );
  try {
    const catalog = await (await fixture.request(`${fixture.base}/catalog`)).json();
    expect(catalog.managed.sandbox).toBe(false);
    const result = await fixture.request(
      `${fixture.base}/comparisons`,
      post({
        id: crypto.randomUUID(),
        tasks: [{ runId: "run-one", taskId: "task-one" }],
        models: [{ catalogId: "gpt-6-sol", credentialId: "managed-model", harnesses: ["pi"] }],
        sandbox: "managed",
        sandboxCredentialId: "managed-sandbox",
      }),
    );
    expect(result.status).toBe(400);
    expect((await result.json()).error).toContain("platform Modal credentials");
    expect(fixture.starts).toHaveLength(0);
  } finally {
    await fixture.close();
  }
});
