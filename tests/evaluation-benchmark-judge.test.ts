import { expect, test } from "bun:test";
import { runCommand } from "../src/lib/process.js";
import { evaluationServer } from "./support/evaluation-fixture.js";
import { memoryVault } from "./support/evaluation-vault.js";
import { fakeHarbor, harborTaskToml, publishedTask } from "./support/harbor-registry.js";

/** A task graded by an LLM judge, as harveyai/lab's are: its verifier reads an Anthropic key. */
const judged = publishedTask(
  "law/memo",
  {
    "task.toml": harborTaskToml("law/memo").replace(
      "[verifier.env]\n",
      `[verifier.env]\nANTHROPIC_API_KEY = "\${ANTHROPIC_API_KEY}"\nJUDGE_CONCURRENCY = "\${JUDGE_CONCURRENCY:-8}"\n`,
    ),
  },
  "4".repeat(64),
);

test("a benchmark graded by an LLM judge runs with the judge credential the user picks", async () => {
  const harbor = fakeHarbor({ "law/lab@latest": [judged] }, runCommand);
  const fixture = await evaluationServer(memoryVault(), { registryCommand: harbor.command });
  const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
  try {
    const credential = async (kind: string) => {
      const response = await fixture.request(
        "/api/orgs/avyay/credentials",
        post({ name: kind, kind, value: "mock-only" }),
      );
      expect(response.status).toBe(201);
      return (await response.json()).id as string;
    };
    expect((await fixture.request(fixture.benchmarks, post({ reference: "law/lab" }))).status).toBe(
      201,
    );
    // The Run page learns which judge variables the tasks read.
    const item = await (await fixture.request(`${fixture.benchmarks}/law/lab`)).json();
    expect(item.benchmark.judge).toEqual({
      variables: ["ANTHROPIC_API_KEY"],
      required: ["ANTHROPIC_API_KEY"],
    });

    const openai = await credential("openai");
    const anthropic = await credential("anthropic");
    const selection = {
      models: [{ catalogId: "gpt-6-sol", credentialId: openai, harnesses: ["codex"] }],
      sandbox: "e2b",
      sandboxCredentialId: await credential("e2b"),
    };
    const path = `${fixture.benchmarks}/law/lab/evaluations/comparisons`;
    const refusal = async (body: object) => {
      const response = await fixture.request(path, post({ ...selection, ...body }));
      expect(response.status).toBe(400);
      return (await response.json()).error;
    };
    expect(await refusal({ id: crypto.randomUUID() })).toBe(
      "These tasks grade with an LLM judge: select a judge credential",
    );
    // A sandbox's key is no model credential, so it can't judge.
    expect(
      await refusal({ id: crypto.randomUUID(), judgeCredentialId: selection.sandboxCredentialId }),
    ).toBe("The judge credential must be an API key for a model provider or a gateway");
    expect(fixture.starts).toHaveLength(0);

    const accepted = await fixture.request(
      path,
      post({ ...selection, id: crypto.randomUUID(), judgeCredentialId: anthropic }),
    );
    expect(accepted.status).toBe(202);
    const input = fixture.starts[0];
    // The model under test keeps its own credential; the judge's is recorded beside it.
    expect(input?.credentials).toMatchObject({
      modelCredentialId: openai,
      judgeCredentialId: anthropic,
    });
    // The judge's credential can't be deleted while the comparison has runs to start.
    const deletion = await fixture.request(
      `/api/orgs/avyay/credentials/${anthropic}/delete`,
      post({}),
    );
    expect(deletion.status).toBe(400);
    expect((await deletion.json()).error).toBe(
      "Credential is needed by an active or pending comparison",
    );
    expect(input?.tasks[0]?.judge).toEqual({
      variables: ["ANTHROPIC_API_KEY"],
      required: ["ANTHROPIC_API_KEY"],
    });
  } finally {
    await fixture.close();
  }
});
