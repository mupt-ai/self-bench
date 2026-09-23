import { expect, test } from "bun:test";
import type { ComparisonDraft } from "../src/evaluation/comparisons.js";
import { initialEvaluation, saveEvaluation } from "../src/evaluation/store.js";
import { evaluationServer } from "./support/evaluation-fixture.js";

test("one model row resolves its saved route and rejects unsupported thinking before dispatch", async () => {
  const fixture = await evaluationServer();
  const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
  try {
    const credential = async (kind: string) => {
      const response = await fixture.request(
        "/api/orgs/avyay/credentials",
        post({
          kind,
          name: kind,
          value: `fake-${kind}`,
        }),
      );
      expect(response.status).toBe(201);
      return (await response.json()).id;
    };
    const router = await credential("openrouter");
    const sandbox = await credential("e2b");
    const draft = {
      id: crypto.randomUUID(),
      tasks: [{ runId: "run-one", taskId: "task-one" }],
      models: [
        { catalogId: "gpt-5.6-sol", credentialId: router, harnesses: ["pi"], thinking: "max" },
      ],
      sandbox: "e2b",
      sandboxCredentialId: sandbox,
    };
    expect((await fixture.request(`${fixture.base}/comparisons`, post(draft))).status).toBe(400);
    expect(fixture.starts).toHaveLength(0);
    draft.models = [
      {
        catalogId: "gpt-5.6-sol",
        credentialId: router,
        harnesses: ["codex"],
        thinking: "default",
      },
    ];
    expect((await fixture.request(`${fixture.base}/comparisons`, post(draft))).status).toBe(400);
    expect(fixture.starts).toHaveLength(0);
    draft.models = [
      { catalogId: "gpt-5.6-sol", credentialId: router, harnesses: ["pi"], thinking: "xhigh" },
    ];
    expect((await fixture.request(`${fixture.base}/comparisons`, post(draft))).status).toBe(202);
    expect(fixture.starts[0]).toMatchObject({
      model: "gpt-5.6-sol",
      modelName: "openrouter/openai/gpt-5.6-sol",
      thinking: "xhigh",
      harnesses: ["pi"],
      pricing: { input: 2 },
      credentials: { provider: "openrouter" },
    });
    draft.models = [
      { catalogId: "gpt-5.6-sol", credentialId: router, harnesses: ["codex"], thinking: "xhigh" },
    ];
    draft.id = crypto.randomUUID();
    expect((await fixture.request(`${fixture.base}/comparisons`, post(draft))).status).toBe(202);
    expect(fixture.starts).toHaveLength(2);
  } finally {
    await fixture.close();
  }
});

test("missing-task runs skip only completed model, harness, thinking and task pairs", async () => {
  const fixture = await evaluationServer();
  const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
  try {
    const save = async (kind: string) => {
      const response = await fixture.request(
        "/api/orgs/avyay/credentials",
        post({ kind, name: kind, value: `fake-${kind}` }),
      );
      return (await response.json()).id as string;
    };
    const credentialId = await save("openrouter");
    const sandboxCredentialId = await save("e2b");
    const draft: ComparisonDraft = {
      id: crypto.randomUUID(),
      tasks: [{ runId: "run-one", taskId: "task-one" }],
      sandbox: "e2b",
      sandboxCredentialId,
      skipCompleted: false,
      models: [
        {
          catalogId: "gpt-5.6-sol",
          credentialId,
          harnesses: ["pi"],
          thinking: "high",
        },
      ],
    };
    expect((await fixture.request(`${fixture.base}/comparisons`, post(draft))).status).toBe(202);
    const input = fixture.starts[0];
    if (!input) throw new Error("Missing evaluation input");
    const completed = initialEvaluation(input, "GPT-5.6 Sol");
    completed.status = "completed";
    completed.sandbox = "modal";
    completed.credentials = {
      modelCredentialId: input.credentials?.modelCredentialId ?? "",
      provider: "openai",
      sandboxCredentialId: "other",
    };
    if (!completed.trials[0]) throw new Error("Missing evaluation trial");
    completed.trials[0].status = "completed";
    await saveEvaluation(fixture.artifacts, completed);

    draft.id = crypto.randomUUID();
    draft.skipCompleted = true;
    const duplicate = await fixture.request(`${fixture.base}/comparisons`, post(draft));
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toEqual({
      error: "Every selected configuration and task already has a completed result.",
    });
    expect(fixture.starts).toHaveLength(1);

    draft.id = crypto.randomUUID();
    const selected = draft.models[0];
    if (!selected) throw new Error("Missing model selection");
    draft.models[0] = { ...selected, thinking: "xhigh" };
    expect((await fixture.request(`${fixture.base}/comparisons`, post(draft))).status).toBe(202);
    expect(fixture.starts).toHaveLength(2);
  } finally {
    await fixture.close();
  }
});

test("OpenRouter credentials allow separate harnesses for one model and reject repeated pairs", async () => {
  const fixture = await evaluationServer();
  const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
  try {
    const save = async (kind: string) => {
      const response = await fixture.request(
        "/api/orgs/avyay/credentials",
        post({ kind, name: kind, value: `fake-${kind}` }),
      );
      expect(response.status).toBe(201);
      return (await response.json()).id as string;
    };
    const credentialId = await save("openrouter");
    const secondCredentialId = await save("openrouter");
    const sandboxCredentialId = await save("e2b");
    const selection = { catalogId: "gpt-5.6-sol", credentialId, thinking: "default" };
    const draft = {
      id: crypto.randomUUID(),
      tasks: [{ runId: "run-one", taskId: "task-one" }],
      sandbox: "e2b",
      sandboxCredentialId,
      models: [
        { ...selection, harnesses: ["codex"], thinking: "low" },
        { ...selection, harnesses: ["mini-swe-agent"] },
      ],
    };
    expect((await fixture.request(`${fixture.base}/comparisons`, post(draft))).status).toBe(202);
    expect(fixture.starts).toHaveLength(2);
    expect(fixture.starts[1]).toMatchObject({
      modelName: "openrouter/openai/gpt-5.6-sol",
      credentials: { provider: "openrouter" },
      harnesses: ["mini-swe-agent"],
    });
    draft.id = crypto.randomUUID();
    draft.models[1] = {
      ...selection,
      credentialId: secondCredentialId,
      harnesses: ["codex"],
      thinking: "low",
    };
    expect((await fixture.request(`${fixture.base}/comparisons`, post(draft))).status).toBe(400);
    expect(fixture.starts).toHaveLength(2);
    draft.models[1] = { ...selection, harnesses: ["codex"], thinking: "high" };
    expect((await fixture.request(`${fixture.base}/comparisons`, post(draft))).status).toBe(202);
    expect(fixture.starts).toHaveLength(4);
  } finally {
    await fixture.close();
  }
});
