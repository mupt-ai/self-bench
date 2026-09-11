import { expect, test } from "bun:test";
import { evaluationServer } from "./support/evaluation-fixture.js";

test("one model row resolves its saved route and rejects unsupported thinking before dispatch", async () => {
  const fixture = await evaluationServer();
  const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
  try {
    const credential = async (kind: string) => {
      const response = await fixture.request(
        `${fixture.base}/credentials`,
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
        { catalogId: "openai-sol56", credentialId: router, harnesses: ["pi"], thinking: "max" },
      ],
      sandbox: "e2b",
      sandboxCredentialId: sandbox,
    };
    expect((await fixture.request(`${fixture.base}/comparisons`, post(draft))).status).toBe(400);
    expect(fixture.starts).toHaveLength(0);
    draft.models = [
      { catalogId: "openai-sol56", credentialId: router, harnesses: ["pi"], thinking: "xhigh" },
    ];
    expect((await fixture.request(`${fixture.base}/comparisons`, post(draft))).status).toBe(202);
    expect(fixture.starts[0]).toMatchObject({
      model: "openai-sol56",
      modelName: "openrouter/openai/gpt-5.6-sol",
      thinking: "xhigh",
      harnesses: ["pi"],
      pricing: { input: 2 },
      credentials: { provider: "openrouter" },
    });
    draft.models = [
      { catalogId: "openai-sol56", credentialId: router, harnesses: ["codex"], thinking: "xhigh" },
    ];
    draft.id = crypto.randomUUID();
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
        `${fixture.base}/credentials`,
        post({ kind, name: kind, value: `fake-${kind}` }),
      );
      expect(response.status).toBe(201);
      return (await response.json()).id as string;
    };
    const credentialId = await save("openrouter");
    const sandboxCredentialId = await save("e2b");
    const selection = { catalogId: "openai-sol56", credentialId, thinking: "default" };
    const draft = {
      id: crypto.randomUUID(),
      tasks: [{ runId: "run-one", taskId: "task-one" }],
      sandbox: "e2b",
      sandboxCredentialId,
      models: [
        { ...selection, harnesses: ["codex"] },
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
    draft.models[1] = { ...selection, harnesses: ["codex"] };
    expect((await fixture.request(`${fixture.base}/comparisons`, post(draft))).status).toBe(400);
    expect(fixture.starts).toHaveLength(2);
    draft.models[1] = { ...selection, harnesses: ["codex"], thinking: "high" };
    expect((await fixture.request(`${fixture.base}/comparisons`, post(draft))).status).toBe(202);
    expect(fixture.starts).toHaveLength(4);
  } finally {
    await fixture.close();
  }
});
