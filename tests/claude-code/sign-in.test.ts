import { afterEach, beforeEach, expect, test } from "bun:test";
import { clearMockModels, mockReferenceModelsAsListed } from "../support/model-catalog.js";

beforeEach(mockReferenceModelsAsListed);
afterEach(clearMockModels);

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialSchema } from "../../src/db/credentials.js";
import { credentialExecution } from "../../src/evaluation/execution.js";
import { createClaudeLogins } from "../../src/harnesses/claude-code/login.js";
import { evaluationServer } from "../support/evaluation-fixture.js";
import { memoryVault } from "../support/evaluation-vault.js";

const token = "sk-ant-oat01-test-token-never-return";

/** Anthropic's token endpoint: accepts the code only with the verifier its challenge came from. */
function anthropic(lifetimeMs?: number) {
  const state = {
    status: 200,
    exchanges: [] as Record<string, unknown>[],
    challenge: "",
    /** Runs while Anthropic is answering, as a browser's cancel could. */
    during: async () => {},
  };
  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe("https://platform.claude.com/v1/oauth/token");
    const body = JSON.parse(String(init?.body));
    state.exchanges.push(body);
    await state.during();
    const verified =
      createHash("sha256").update(body.code_verifier).digest("base64url") === state.challenge;
    if (state.status !== 200) return new Response(null, { status: state.status });
    return verified && body.code === "good-code"
      ? Response.json({ access_token: token, expires_in: body.expires_in })
      : Response.json({ error: "invalid_grant" }, { status: 400 });
  }) as typeof fetch;
  return { state, logins: createClaudeLogins(request, lifetimeMs) };
}

test("a pasted code is exchanged with the sealed verifier and saved once as a Claude sign-in", async () => {
  const { state, logins } = anthropic();
  const vault = memoryVault();
  const pending = await logins.start(vault, 4, 7, " Team Claude ");
  const authorize = new URL(pending.authorizeUrl ?? "");
  expect(authorize.searchParams.get("scope")).toBe("user:inference");
  state.challenge = authorize.searchParams.get("code_challenge") ?? "";
  const sent = authorize.searchParams.get("state");

  await expect(logins.complete(vault, 4, 8, pending.id, `good-code#${sent}`)).rejects.toThrow(
    "expired",
  );
  for (const pasted of ["good-code#other", "good-code"])
    await expect(logins.complete(vault, 4, 7, pending.id, pasted)).rejects.toThrow(
      "not from this sign-in",
    );
  // Anthropic outages and rejected codes keep the sign-in open for another try.
  state.status = 503;
  await expect(logins.complete(vault, 4, 7, pending.id, `good-code#${sent}`)).rejects.toThrow(
    "reach Anthropic",
  );
  state.status = 200;
  await expect(logins.complete(vault, 4, 7, pending.id, `bad-code#${sent}`)).rejects.toThrow(
    "did not accept",
  );

  const saved = await logins.complete(vault, 4, 7, pending.id, ` good-code#${sent} `);
  expect(saved.status).toBe("saved");
  expect(saved.credential).toMatchObject({
    id: pending.id,
    name: "Team Claude",
    kind: "anthropic",
    auth: "claude-login",
  });
  expect(JSON.stringify(saved)).not.toContain(token);
  expect(state.exchanges.at(-1)).toMatchObject({ state: sent, expires_in: 31_536_000 });
  expect((await vault.credentials.secret(4, pending.id))?.value).toBe(token);
  expect((await logins.complete(vault, 4, 7, pending.id, "anything")).status).toBe("saved");
  expect(await vault.credentials.list(4)).toHaveLength(1);

  // Cancelled while Anthropic exchanged the code: nothing is saved.
  const cancelled = await logins.start(vault, 4, 7, "Claude");
  const cancelledUrl = new URL(cancelled.authorizeUrl ?? "");
  state.challenge = cancelledUrl.searchParams.get("code_challenge") ?? "";
  state.during = () => logins.cancel(vault, 4, 7, cancelled.id);
  await expect(
    logins.complete(
      vault,
      4,
      7,
      cancelled.id,
      `good-code#${cancelledUrl.searchParams.get("state")}`,
    ),
  ).rejects.toThrow("expired");
  expect(await vault.credentials.list(4)).toHaveLength(1);
  const expiring = anthropic(0).logins;
  const expired = await expiring.start(vault, 4, 7, "Claude");
  await expect(expiring.complete(vault, 4, 7, expired.id, "good-code")).rejects.toThrow("expired");
});

test("an HTTP Claude sign-in becomes a credential that runs only Claude Code, by forced OAuth", async () => {
  const { state, logins } = anthropic();
  const vault = memoryVault();
  const site = await evaluationServer(vault, { claudeLogins: logins });
  const base = "/api/orgs/avyay/credentials/claude-login";
  const post = (body: object) => ({ method: "POST", body: JSON.stringify(body) });
  const home = await mkdtemp(join(tmpdir(), "claude-auth-fixture-"));
  try {
    expect((await site.request(base, post({ name: "Claude" }), null)).status).toBe(401);
    expect((await site.request(base, post({ name: "Claude" }), 2)).status).toBe(404);
    const start = await site.request(base, post({ name: "Claude" }));
    expect(start.status).toBe(202);
    const pending = await start.json();
    const authorize = new URL(pending.authorizeUrl);
    state.challenge = authorize.searchParams.get("code_challenge") ?? "";
    const code = `good-code#${authorize.searchParams.get("state")}`;
    expect((await site.request(`${base}/${pending.id}`)).status).toBe(405);
    const saved = await site.request(`${base}/${pending.id}/complete`, post({ code }));
    const body = await saved.text();
    expect(saved.status).toBe(200);
    expect(JSON.parse(body).status).toBe("saved");
    expect(body).not.toContain(token);

    const sandbox = await (
      await site.request(
        "/api/orgs/avyay/credentials",
        post({ name: "Sandbox", kind: "e2b", value: "fake-sandbox" }),
      )
    ).json();
    const model = { catalogId: "claude-sonnet-5", credentialId: pending.id, harnesses: ["pi"] };
    const draft = {
      id: crypto.randomUUID(),
      tasks: [{ runId: "run-one", taskId: "task-one" }],
      models: [model],
      sandbox: "e2b",
      sandboxCredentialId: sandbox.id,
    };
    const refused = await site.request(`${site.base}/comparisons`, post(draft));
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toContain("can only run the Claude Code harness");
    draft.models = [{ ...model, harnesses: ["claude-code"] }];
    expect((await site.request(`${site.base}/comparisons`, post(draft))).status).toBe(202);
    const input = site.starts[0];
    if (!input) throw new Error("Missing input");
    expect(input.credentials?.auth).toBe("claude-login");
    const execution = await credentialExecution(
      input,
      home,
      { ANTHROPIC_API_KEY: "unused" },
      vault,
    );
    expect(execution.child.ANTHROPIC_API_KEY).toBeUndefined();
    expect(execution.child.CLAUDE_CODE_OAUTH_TOKEN).toBe(token);
    expect(execution.child.CLAUDE_FORCE_OAUTH).toBe("1");
    expect(execution.secrets).toContain(token);
  } finally {
    await site.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("a Claude subscription token is only accepted as an Anthropic Claude sign-in", () => {
  for (const [kind, auth, value] of [
    ["openai", "claude-login", token],
    ["anthropic", "api-key", token],
    ["anthropic", "claude-login", "sk-ant-api03-key"],
  ] as const)
    expect(credentialSchema.safeParse({ name: "wrong", kind, auth, value }).success).toBe(false);
});
