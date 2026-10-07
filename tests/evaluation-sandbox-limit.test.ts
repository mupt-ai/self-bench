import { expect, test } from "bun:test";
import { evaluationServer } from "./support/evaluation-fixture.js";
import { memoryVault } from "./support/evaluation-vault.js";

const credentialsUrl = "/api/orgs/avyay/credentials";
const post = (value: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(value) });

test("a sandbox credential's limit caps its evaluations' trials, split across a comparison", async () => {
  const fixture = await evaluationServer(memoryVault());
  try {
    const create = async (body: Record<string, unknown>) =>
      await fixture.request(credentialsUrl, post({ name: "Key", value: "secret", ...body }));
    const modelKey = (await (await create({ kind: "openai" })).json()).id as string;
    expect((await create({ kind: "openai", maxSandboxes: 4 })).status).toBe(400);
    const created = await create({ kind: "e2b", maxSandboxes: 20 });
    const sandbox = await created.json();
    expect(sandbox.maxSandboxes).toBe(20);
    const limit = (id: string, maxSandboxes: unknown) =>
      fixture.request(`${credentialsUrl}/${id}/limit`, post({ maxSandboxes }));
    expect((await limit(sandbox.id, 0)).status).toBe(400);
    expect((await limit(modelKey, 4)).status).toBe(400);
    expect((await (await limit(sandbox.id, 7)).json()).maxSandboxes).toBe(7);
    const compare = () =>
      fixture.request(
        `${fixture.base}/comparisons`,
        post({
          id: crypto.randomUUID(),
          tasks: [{ runId: "run-one", taskId: "task-one" }],
          models: [
            { catalogId: "gpt-6-astra", credentialId: modelKey, harnesses: ["codex", "pi"] },
            { catalogId: "gpt-6-sol", credentialId: modelKey, harnesses: ["codex"] },
          ],
          sandbox: "e2b",
          sandboxCredentialId: sandbox.id,
        }),
      );
    // The comparison's two evaluations start together, so each gets half of the seven.
    expect((await compare()).status).toBe(202);
    expect(fixture.starts.map((input) => input.maxTrials)).toEqual([3, 3]);
    expect((await (await limit(sandbox.id, null)).json()).maxSandboxes).toBeUndefined();
    expect((await compare()).status).toBe(202);
    expect(fixture.starts.slice(2).map((input) => input.maxTrials)).toEqual([undefined, undefined]);
  } finally {
    await fixture.close();
  }
});
