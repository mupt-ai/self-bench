import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialSchema, validateEndpoint } from "../src/db/credentials.js";
import type { ComparisonDraft } from "../src/evaluation/comparisons.js";
import { credentialExecution } from "../src/evaluation/execution.js";
import { initialEvaluation, saveEvaluation } from "../src/evaluation/store.js";
import { evaluationEnv, evaluationServer } from "./support/evaluation-fixture.js";
import { memoryVault } from "./support/evaluation-vault.js";

const credentialsUrl = "/api/orgs/avyay/credentials";

const post = (value: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(value) });

test("catalog is populated without keys and only exposes supported provider families", async () => {
  const fixture = await evaluationServer(memoryVault());
  try {
    const response = await fixture.request(`${fixture.base}/catalog`);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.models.length).toBeGreaterThan(4);
    expect(new Set(body.models.map((model: { provider: string }) => model.provider))).toEqual(
      new Set(["openai", "anthropic", "openrouter"]),
    );
    expect(body.sandboxes).not.toContain("docker");
    expect((await fixture.request(`${fixture.base}/catalog`, {}, null)).status).toBe(401);
    expect((await fixture.request(credentialsUrl, {}, 2)).status).toBe(404);
  } finally {
    await fixture.close();
  }
});

test("managed evaluations use the platform model and sandbox credentials", async () => {
  const records = memoryVault();
  const env = {
    ...evaluationEnv,
    SELFBENCH_MANAGED_OPENROUTER_API_KEY: "managed-model-secret",
    SELFBENCH_MANAGED_E2B_API_KEY: "managed-sandbox-secret",
    SELFBENCH_MANAGED_MODAL_TOKEN_ID: "managed-modal-id",
    SELFBENCH_MANAGED_MODAL_TOKEN_SECRET: "managed-modal-secret",
    SELFBENCH_MANAGED_MODAL_ENVIRONMENT: "selfbench-test",
  };
  const fixture = await evaluationServer(records, undefined, env);
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
    const execution = await credentialExecution(input, home, env, records);
    expect(execution.child.OPENROUTER_API_KEY).toBe("managed-model-secret");
    expect(execution.child.MODAL_TOKEN_ID).toBe("managed-modal-id");
    expect(execution.child.MODAL_TOKEN_SECRET).toBe("managed-modal-secret");
    expect(execution.child.MODAL_ENVIRONMENT).toBe("selfbench-test");
    expect(execution.child.E2B_API_KEY).toBeUndefined();
    expect(execution.secrets).toContain("managed-model-secret");
    expect(execution.secrets).toContain("managed-modal-secret");
  } finally {
    await fixture.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("managed evaluation requires Modal even when managed E2B is configured", async () => {
  const fixture = await evaluationServer(memoryVault(), undefined, {
    ...evaluationEnv,
    SELFBENCH_MANAGED_E2B_API_KEY: "managed-e2b",
  });
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

test("durable comparison, scoped credentials, frozen tasks, partial dispatch and deletion protection", async () => {
  const records = memoryVault();
  const fixture = await evaluationServer(records);
  try {
    const create = async (kind: string, value: string) => {
      const response = await fixture.request(credentialsUrl, post({ name: kind, kind, value }));
      expect(response.status).toBe(201);
      const info = await response.json();
      expect(JSON.stringify(info)).not.toContain(value);
      return info.id as string;
    };
    const modelKey = await create("openai", "model-secret");
    const sandboxKey = await create("e2b", "sandbox-secret");
    const draft: ComparisonDraft = {
      id: crypto.randomUUID(),
      tasks: [{ runId: "run-one", taskId: "task-one" }],
      models: [
        {
          catalogId: "gpt-6-astra",
          credentialId: modelKey,
          harnesses: ["codex", "pi"],
          thinking: "xhigh",
        },
        { catalogId: "gpt-6-sol", credentialId: modelKey, harnesses: ["codex"] },
      ],
      sandbox: "e2b",
      sandboxCredentialId: sandboxKey,
    };
    fixture.failStart(true);
    const saved = await fixture.request(`${fixture.base}/comparisons`, post(draft));
    expect(saved.status).toBe(202);
    expect((await saved.json()).submissionError).toBeDefined();
    const comparisons = await records.comparisons.listForRepo(fixture.repo.id);
    expect(comparisons).toHaveLength(1);
    const comparison = comparisons[0];
    if (!comparison) throw new Error("Missing comparison");
    expect(comparison.inputs[0]?.tasks).toEqual(comparison.inputs[1]?.tasks);
    expect(comparison.inputs[0]?.thinking).toBe("xhigh");
    expect(JSON.stringify(comparison)).not.toContain("model-secret");
    const deletion = await fixture.request(`${credentialsUrl}/${modelKey}/delete`, post({}));
    expect(deletion.status).toBe(400);
    expect((await fixture.request(`${fixture.base}/comparisons/${draft.id}`, {}, 2)).status).toBe(
      404,
    );
    const otherRepo = fixture.base.replace("/repo/", "/other/");
    expect((await fixture.request(`${otherRepo}/comparisons/${draft.id}`)).status).toBe(404);
    fixture.failStart(false);
    await fixture.request(`${fixture.base}/comparisons/${draft.id}/resume`, post({}));
    expect(fixture.starts).toHaveLength(2);
    expect(fixture.starts.map((input) => input.id)).toEqual(
      comparison.inputs.map((input) => input.id),
    );
    const changed = await fixture.request(
      `${fixture.base}/comparisons`,
      post({ ...draft, sandbox: "modal" }),
    );
    expect(changed.status).toBe(400);
    const first = comparison.inputs[0];
    if (!first) throw new Error("Missing input");
    const home = await mkdtemp(join(tmpdir(), "credential-execution-"));
    try {
      const execution = await credentialExecution(
        first,
        home,
        { PATH: "/bin", GITHUB_TOKEN: "host-secret", OPENAI_API_KEY: "unrelated-key" },
        records,
      );
      expect(execution.child.OPENAI_API_KEY).toBe("model-secret");
      expect(execution.child.E2B_API_KEY).toBe("sandbox-secret");
      expect(execution.child.GITHUB_TOKEN).toBeUndefined();
      expect(execution.child.SELFBENCH_BAO_TOKEN).toBeUndefined();
      await expect(
        credentialExecution({ ...first, modelName: "openai/tampered" }, home, {}, records),
      ).rejects.toThrow("reserved comparison");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
    for (const input of comparison.inputs) {
      const run = initialEvaluation(input, input.modelName);
      run.status = "completed";
      await saveEvaluation(fixture.artifacts, run);
    }
    expect((await fixture.request(`${credentialsUrl}/${modelKey}/delete`, post({}))).status).toBe(
      200,
    );
    await fixture.request(`${fixture.base}/comparisons/${draft.id}/resume`, post({}));
    expect(fixture.starts).toHaveLength(2);
  } finally {
    await fixture.close();
  }
});

test("credential validation rejects auth mixing and unsafe custom endpoints", async () => {
  expect(
    credentialSchema.safeParse({
      name: "wrong",
      kind: "anthropic",
      auth: "codex-login",
      value: "{}",
    }).success,
  ).toBe(false);
  expect(
    credentialSchema.safeParse({ name: "wrong", kind: "modal", value: "secret" }).success,
  ).toBe(false);
  expect(() => validateEndpoint("http://127.0.0.1/v1", {})).toThrow("operator-approved");
  expect(() => validateEndpoint("https://api.example/v1", {})).toThrow("operator-approved");
  expect(
    validateEndpoint("https://api.example/v1/", {
      SELFBENCH_CUSTOM_MODEL_HOSTS: "api.example",
    }),
  ).toBe("https://api.example/v1");
});

test("Codex sign-in is explicit, scoped and never falls back to an API key", async () => {
  const records = memoryVault();
  const fixture = await evaluationServer(records);
  const home = await mkdtemp(join(tmpdir(), "codex-auth-fixture-"));
  try {
    const auth = JSON.stringify({
      tokens: { access_token: "fake-access", refresh_token: "fake-refresh" },
    });
    const model = await (
      await fixture.request(
        credentialsUrl,
        post({ name: "Codex", kind: "openai", auth: "codex-login", value: auth }),
      )
    ).json();
    const sandbox = await (
      await fixture.request(
        credentialsUrl,
        post({ name: "Sandbox", kind: "e2b", value: "fake-sandbox" }),
      )
    ).json();
    const draft = {
      id: crypto.randomUUID(),
      tasks: [{ runId: "run-one", taskId: "task-one" }],
      models: [{ catalogId: "gpt-6-sol", credentialId: model.id, harnesses: ["pi"] }],
      sandbox: "e2b",
      sandboxCredentialId: sandbox.id,
    };
    expect((await fixture.request(`${fixture.base}/comparisons`, post(draft))).status).toBe(400);
    draft.models[0] = {
      ...draft.models[0],
      catalogId: "gpt-6-sol",
      credentialId: model.id,
      harnesses: ["codex"],
    };
    expect((await fixture.request(`${fixture.base}/comparisons`, post(draft))).status).toBe(202);
    const input = fixture.starts[0];
    if (!input) throw new Error("Missing input");
    expect(input.pricing).toMatchObject({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 });
    const execution = await credentialExecution(
      input,
      home,
      { OPENAI_API_KEY: "do-not-use" },
      records,
    );
    expect(execution.child.OPENAI_API_KEY).toBeUndefined();
    expect(await readFile(execution.child.CODEX_AUTH_JSON_PATH ?? "", "utf8")).toBe(auth);
    expect(execution.secrets).toContain("fake-refresh");
  } finally {
    await fixture.close();
    await rm(home, { recursive: true, force: true });
  }
});
