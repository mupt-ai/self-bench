import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialSchema } from "../../src/db/credentials.js";
import { credentialExecution } from "../../src/evaluation/execution.js";
import { evaluationServer } from "../support/evaluation-fixture.js";
import { memoryVault } from "../support/evaluation-vault.js";

const credentialsUrl = "/api/orgs/avyay/credentials";
const post = (value: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(value) });

test("a Claude subscription token is only accepted as an Anthropic Claude sign-in", () => {
  const claudeToken = "sk-ant-oat01-fake";
  for (const [kind, auth] of [
    ["openai", "claude-login"],
    ["anthropic", "api-key"],
  ] as const)
    expect(
      credentialSchema.safeParse({ name: "wrong", kind, auth, value: claudeToken }).success,
    ).toBe(false);
  expect(
    credentialSchema.safeParse({
      name: "wrong",
      kind: "anthropic",
      auth: "claude-login",
      value: "sk-ant-api03-key",
    }).success,
  ).toBe(false);
});

test("Claude sign-in runs only Claude Code, through Harbor's forced OAuth token", async () => {
  const records = memoryVault();
  const fixture = await evaluationServer(records);
  const home = await mkdtemp(join(tmpdir(), "claude-auth-fixture-"));
  try {
    const token = "sk-ant-oat01-fake-subscription";
    const model = await (
      await fixture.request(
        credentialsUrl,
        post({ name: "Claude", kind: "anthropic", auth: "claude-login", value: token }),
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
      models: [{ catalogId: "claude-sonnet-5", credentialId: model.id, harnesses: ["pi"] }],
      sandbox: "e2b",
      sandboxCredentialId: sandbox.id,
    };
    const refused = await fixture.request(`${fixture.base}/comparisons`, post(draft));
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toContain("can only run the Claude Code harness");
    draft.models[0] = {
      catalogId: "claude-sonnet-5",
      credentialId: model.id,
      harnesses: ["claude-code"],
    };
    expect((await fixture.request(`${fixture.base}/comparisons`, post(draft))).status).toBe(202);
    const input = fixture.starts[0];
    if (!input) throw new Error("Missing input");
    expect(input.credentials?.auth).toBe("claude-login");
    const execution = await credentialExecution(
      input,
      home,
      { ANTHROPIC_API_KEY: "do-not-use" },
      records,
    );
    expect(execution.child.ANTHROPIC_API_KEY).toBeUndefined();
    expect(execution.child.CLAUDE_CODE_OAUTH_TOKEN).toBe(token);
    expect(execution.child.CLAUDE_FORCE_OAUTH).toBe("1");
    expect(execution.secrets).toContain(token);
  } finally {
    await fixture.close();
    await rm(home, { recursive: true, force: true });
  }
});
