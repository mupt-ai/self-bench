import { expect, test } from "bun:test";
import { evaluationServer } from "./support/evaluation-fixture.js";
import { memoryVault } from "./support/evaluation-vault.js";

const credentialsUrl = "/api/orgs/avyay/credentials";
const post = (value: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(value) });

test("sandbox and model credential limits cap their evaluations' trials, split across a comparison", async () => {
  const fixture = await evaluationServer(memoryVault());
  try {
    const create = async (body: Record<string, unknown>) =>
      await fixture.request(credentialsUrl, post({ name: "Key", value: "secret", ...body }));
    const modelKey = (await (await create({ kind: "openai" })).json()).id as string;
    expect((await (await create({ kind: "meta", maxSandboxes: 4 })).json()).maxSandboxes).toBe(4);
    const created = await create({ kind: "e2b", maxSandboxes: 20 });
    const sandbox = await created.json();
    expect(sandbox.maxSandboxes).toBe(20);
    const limit = (id: string, maxSandboxes: unknown) =>
      fixture.request(`${credentialsUrl}/${id}/limit`, post({ maxSandboxes }));
    expect((await limit(sandbox.id, 0)).status).toBe(400);
    expect((await (await limit(sandbox.id, 7)).json()).maxSandboxes).toBe(7);
    // The build limit is set apart, and leaves the sandbox limit as it was.
    const limitBuilds = (maxBuilds: unknown) =>
      fixture.request(`${credentialsUrl}/${sandbox.id}/limit`, post({ maxBuilds }));
    expect((await limitBuilds(0)).status).toBe(400);
    expect(await (await limitBuilds(10)).json()).toMatchObject({ maxSandboxes: 7, maxBuilds: 10 });
    expect((await (await limit(sandbox.id, 7)).json()).maxBuilds).toBe(10);
    expect((await (await limitBuilds(null)).json()).maxBuilds).toBeUndefined();
    // Renaming keeps the limits; a blank name is refused.
    const update = (body: unknown) =>
      fixture.request(`${credentialsUrl}/${sandbox.id}/update`, post(body));
    expect(await (await update({ name: "Team E2B" })).json()).toMatchObject({
      name: "Team E2B",
      maxSandboxes: 7,
    });
    expect((await update({ name: "" })).status).toBe(400);
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
    // Both evaluations call one model key, so they also split its four.
    expect((await (await limit(modelKey, 4)).json()).maxSandboxes).toBe(4);
    expect((await compare()).status).toBe(202);
    expect(fixture.starts.slice(2).map((input) => input.maxTrials)).toEqual([2, 2]);
    expect((await (await limit(sandbox.id, null)).json()).maxSandboxes).toBeUndefined();
    expect((await compare()).status).toBe(202);
    expect(fixture.starts.slice(4).map((input) => input.maxTrials)).toEqual([2, 2]);
    expect((await (await limit(modelKey, null)).json()).maxSandboxes).toBeUndefined();
    expect((await compare()).status).toBe(202);
    expect(fixture.starts.slice(6).map((input) => input.maxTrials)).toEqual([undefined, undefined]);
  } finally {
    await fixture.close();
  }
});
