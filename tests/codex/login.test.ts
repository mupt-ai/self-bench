import { expect, test } from "bun:test";
import { createCodexLogins } from "../../src/harnesses/codex/login.js";
import { evaluationServer } from "../support/evaluation-fixture.js";
import { memoryVault } from "../support/evaluation-vault.js";

const idToken = [
  "header",
  Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } }),
  ).toString("base64url"),
  "signature",
].join(".");

/** OpenAI's device-code endpoints: pending until approved, then one authorization code. */
function openAI(lifetimeMs?: number) {
  const state = { approved: false, calls: [] as string[], pollStatus: 0, tokenStatus: 200 };
  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    state.calls.push(path);
    if (path === "/api/accounts/deviceauth/usercode")
      return Response.json({ device_auth_id: "device-1", user_code: "TEST-CODE", interval: "5" });
    if (path === "/api/accounts/deviceauth/token") {
      expect(JSON.parse(String(init?.body))).toEqual({
        device_auth_id: "device-1",
        user_code: "TEST-CODE",
      });
      if (state.pollStatus) return new Response(null, { status: state.pollStatus });
      return state.approved
        ? Response.json({ authorization_code: "code", code_challenge: "c", code_verifier: "v" })
        : new Response(null, { status: 403 });
    }
    if (path === "/oauth/token") {
      expect(new URLSearchParams(String(init?.body)).get("code_verifier")).toBe("v");
      return Response.json(
        {
          id_token: idToken,
          access_token: "test-access-never-return",
          refresh_token: "test-refresh-never-return",
        },
        { status: state.tokenStatus },
      );
    }
    return new Response(null, { status: 500 });
  }) as typeof fetch;
  return { state, logins: createCodexLogins(request, lifetimeMs) };
}

test("device sign-in saves once, keeps secrets out of status, and enforces ceremony ownership", async () => {
  const { state, logins } = openAI();
  const vault = memoryVault();
  const pending = await logins.start(vault, 4, 7, " Team Codex ");
  expect(pending.status).toBe("waiting");
  expect(pending.instructions).toEqual({
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "TEST-CODE",
  });
  expect((await logins.status(vault, 4, 7, pending.id)).status).toBe("waiting");
  await expect(logins.status(vault, 4, 8, pending.id)).rejects.toThrow("expired");
  await expect(logins.status(vault, 5, 7, pending.id)).rejects.toThrow("expired");
  await expect(logins.cancel(vault, 5, 7, pending.id)).rejects.toThrow("expired");
  state.approved = true;
  const saved = await Promise.all([
    logins.status(vault, 4, 7, pending.id),
    logins.status(vault, 4, 7, pending.id),
  ]);
  expect(saved.map((view) => view.status)).toEqual(["saved", "saved"]);
  expect(saved[0]?.credential?.id).toBe(pending.id);
  expect(saved[0]?.credential?.name).toBe("Team Codex");
  expect(JSON.stringify(saved)).not.toContain("test-");
  expect((await logins.status(vault, 4, 7, pending.id)).status).toBe("saved");
  expect(await vault.credentials.list(4)).toHaveLength(1);
  const auth = JSON.parse((await vault.credentials.secret(4, pending.id))?.value ?? "{}");
  expect(auth).toMatchObject({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: idToken,
      refresh_token: "test-refresh-never-return",
      account_id: "account-1",
    },
  });
});

test("cancellation, expiry and a rejected exchange end the sign-in", async () => {
  const { state, logins } = openAI();
  const vault = memoryVault();
  const cancelled = await logins.start(vault, 4, 7, "Codex");
  await logins.cancel(vault, 4, 7, cancelled.id);
  await expect(logins.status(vault, 4, 7, cancelled.id)).rejects.toThrow("expired");

  const rejected = await logins.start(vault, 4, 7, "Codex");
  state.approved = true;
  // OpenAI throttling or an outage is not a verdict: the sign-in keeps waiting.
  state.pollStatus = 503;
  expect((await logins.status(vault, 4, 7, rejected.id)).status).toBe("waiting");
  state.pollStatus = 0;
  state.tokenStatus = 429;
  expect((await logins.status(vault, 4, 7, rejected.id)).status).toBe("waiting");
  // The one-time code was kept: the retry exchanges it without asking OpenAI for it again.
  const polls = state.calls.filter((path) => path === "/api/accounts/deviceauth/token").length;
  state.tokenStatus = 400;
  const failed = await logins.status(vault, 4, 7, rejected.id);
  expect(failed.status).toBe("failed");
  expect(state.calls.filter((path) => path === "/api/accounts/deviceauth/token")).toHaveLength(
    polls,
  );
  await expect(logins.status(vault, 4, 7, rejected.id)).rejects.toThrow("expired");
  expect(await vault.credentials.list(4)).toHaveLength(0);

  const expiring = openAI(0).logins;
  const expired = await expiring.start(vault, 4, 7, "Codex");
  await expect(expiring.status(vault, 4, 7, expired.id)).rejects.toThrow("expired");
});

test("HTTP sign-in requires admin, same origin and current user; status exposes only saved metadata", async () => {
  const { state, logins } = openAI();
  const site = await evaluationServer(memoryVault(), logins);
  const base = "/api/orgs/avyay/credentials/codex-login";
  const post = (body: object) => ({ method: "POST", body: JSON.stringify(body) });
  try {
    expect((await site.request(base, post({ name: "Codex" }), null)).status).toBe(401);
    expect((await site.request(base, post({ name: "Codex" }), 2)).status).toBe(404);
    expect(
      (
        await site.request(base, {
          ...post({ name: "Codex" }),
          headers: { origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    expect((await site.request(base, post({ name: "" }))).status).toBe(400);
    const team = { githubId: 20, login: "team", role: "member" as const };
    await site.users.upsert({
      githubId: 2,
      login: "outsider",
      token: "other-secret",
      scopes: "repo",
      orgs: [team],
    });
    expect(
      (await site.request("/api/orgs/team/credentials/codex-login", post({ name: "Codex" }), 2))
        .status,
    ).toBe(403);
    const start = await site.request(base, post({ name: "Team Codex" }));
    expect(start.status).toBe(202);
    const pending = await start.json();
    const waiting = await site.request(`${base}/${pending.id}`);
    expect(waiting.headers.get("cache-control")).toBe("no-store");
    expect((await waiting.json()).status).toBe("waiting");
    state.approved = true;
    const saved = await site.request(`${base}/${pending.id}`);
    const body = await saved.text();
    expect(JSON.parse(body).status).toBe("saved");
    expect(body).not.toContain("test-access");
    const list = await (await site.request("/api/orgs/avyay/credentials")).json();
    expect(list.credentials).toHaveLength(1);
    expect(list.credentials[0].auth).toBe("codex-login");
    expect((await site.request(`${base}/${pending.id}/complete`, post({}))).status).toBe(404);
  } finally {
    await site.close();
  }
});
