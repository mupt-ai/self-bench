import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialSchema } from "../../src/db/credentials.js";
import { credentialExecution, gatewayTrial } from "../../src/evaluation/execution.js";
import { solverArguments } from "../../src/evaluation/solver-arguments.js";
import { createMuseLogins, museAuthFile } from "../../src/harnesses/muse-code/login.js";
import { evaluationServer } from "../support/evaluation-fixture.js";
import { memoryVault } from "../support/evaluation-vault.js";

const token = "test-meta-access-never-return";

/** Meta's device-code endpoints: pending until approved or declined, then the access token. */
function meta(lifetimeMs?: number) {
  const state = {
    answer: "pending" as "pending" | "approved" | "declined" | "slow" | "outage",
    expiresIn: 600,
    calls: [] as string[],
  };
  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://auth.meta.com");
    const form = new URLSearchParams(String(init?.body));
    expect(form.get("client_id")).toBe("1031625952748946");
    state.calls.push(url.pathname);
    if (url.pathname === "/oidc/device/authorization/")
      return Response.json({
        device_code: "device-1",
        user_code: "ABCD-EFGH",
        verification_uri: "https://auth.meta.com/oauth/device/",
        verification_uri_complete: "https://auth.meta.com/oauth/device/?code=ABCD-EFGH",
        expires_in: state.expiresIn,
        interval: 5,
      });
    expect(url.pathname).toBe("/oidc/device/token/");
    expect(form.get("device_code")).toBe("device-1");
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    if (state.answer === "outage") return new Response(null, { status: 503 });
    if (state.answer === "approved")
      return Response.json({ access_token: token, token_type: "Bearer" });
    const error = {
      pending: "authorization_pending",
      slow: "slow_down",
      declined: "access_denied",
    };
    return Response.json({ error: error[state.answer] }, { status: 400 });
  }) as typeof fetch;
  return { state, logins: createMuseLogins(request, lifetimeMs) };
}

test("a Meta device sign-in saves Muse Code's auth.json once and keeps the token out of status", async () => {
  const { state, logins } = meta();
  const vault = memoryVault();
  const pending = await logins.start(vault, 4, 7, " Team Muse ");
  expect(pending.instructions).toEqual({
    verificationUrl: "https://auth.meta.com/oauth/device/?code=ABCD-EFGH",
    userCode: "ABCD-EFGH",
  });
  expect((await logins.status(vault, 4, 7, pending.id)).status).toBe("waiting");
  await expect(logins.status(vault, 4, 8, pending.id)).rejects.toThrow("expired");
  await expect(logins.status(vault, 5, 7, pending.id)).rejects.toThrow("expired");
  // Polling too fast or an outage is not a verdict.
  for (const answer of ["slow", "outage"] as const) {
    state.answer = answer;
    expect((await logins.status(vault, 4, 7, pending.id)).status).toBe("waiting");
  }
  state.answer = "approved";
  const saved = await Promise.all([
    logins.status(vault, 4, 7, pending.id),
    logins.status(vault, 4, 7, pending.id),
  ]);
  expect(saved.map((view) => view.status)).toEqual(["saved", "saved"]);
  expect(saved[0]?.credential).toMatchObject({
    id: pending.id,
    name: "Team Muse",
    kind: "meta",
    auth: "muse-login",
  });
  expect(JSON.stringify(saved)).not.toContain(token);
  expect(await vault.credentials.list(4)).toHaveLength(1);
  const auth = JSON.parse((await vault.credentials.secret(4, pending.id))?.value ?? "{}");
  expect(auth).toEqual({
    schema_version: 1,
    providers: {
      meta: {
        mechanism: "oauth",
        storage: "file",
        obtained_via: "device_code",
        access_token: token,
        api_base_url: "https://api.meta.ai/v1",
      },
    },
  });
});

test("a declined, cancelled or expired Meta sign-in ends without a credential", async () => {
  const { state, logins } = meta();
  const vault = memoryVault();
  const declined = await logins.start(vault, 4, 7, "Muse");
  state.answer = "declined";
  const failed = await logins.status(vault, 4, 7, declined.id);
  expect(failed).toMatchObject({ status: "failed", error: expect.stringContaining("declined") });
  await expect(logins.status(vault, 4, 7, declined.id)).rejects.toThrow("expired");

  const cancelled = await logins.start(vault, 4, 7, "Muse");
  await logins.cancel(vault, 4, 7, cancelled.id);
  await expect(logins.status(vault, 4, 7, cancelled.id)).rejects.toThrow("expired");

  // Meta's code lasts as long as it says, however long SelfBench would wait.
  state.expiresIn = 0.001;
  const expired = await logins.start(vault, 4, 7, "Muse");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await expect(logins.status(vault, 4, 7, expired.id)).rejects.toThrow("expired");
  expect(await vault.credentials.list(4)).toHaveLength(0);
});

test("an HTTP Meta sign-in runs only Muse Code, signed in through its own auth.json", async () => {
  const { state, logins } = meta();
  const vault = memoryVault();
  const site = await evaluationServer(vault, { museLogins: logins });
  const base = "/api/orgs/avyay/credentials/muse-login";
  const post = (body: object) => ({ method: "POST", body: JSON.stringify(body) });
  const home = await mkdtemp(join(tmpdir(), "muse-auth-fixture-"));
  try {
    expect((await site.request(base, post({ name: "Muse" }), null)).status).toBe(401);
    expect((await site.request(base, post({ name: "Muse" }), 2)).status).toBe(404);
    const start = await site.request(base, post({ name: "Muse" }));
    expect(start.status).toBe(202);
    const pending = await start.json();
    expect((await (await site.request(`${base}/${pending.id}`)).json()).status).toBe("waiting");
    state.answer = "approved";
    const saved = await site.request(`${base}/${pending.id}`);
    const body = await saved.text();
    expect(JSON.parse(body).status).toBe("saved");
    expect(body).not.toContain(token);
    expect((await site.request(`${base}/${pending.id}/complete`, post({}))).status).toBe(405);

    const sandbox = await (
      await site.request(
        "/api/orgs/avyay/credentials",
        post({ name: "Sandbox", kind: "e2b", value: "fake-sandbox" }),
      )
    ).json();
    const model = { catalogId: "muse-spark-1.3", credentialId: pending.id, harnesses: ["pi"] };
    const draft = {
      id: crypto.randomUUID(),
      tasks: [{ runId: "run-one", taskId: "task-one" }],
      models: [model],
      sandbox: "e2b",
      sandboxCredentialId: sandbox.id,
    };
    const refused = await site.request(`${site.base}/comparisons`, post(draft));
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toContain("can only run the Muse Code harness");
    draft.models = [{ ...model, harnesses: ["muse-code"] }];
    expect((await site.request(`${site.base}/comparisons`, post(draft))).status).toBe(202);
    const input = site.starts[0];
    if (!input) throw new Error("Missing input");
    expect(input).toMatchObject({
      modelName: "meta/muse-spark-1.3",
      thinking: "high",
      credentials: { provider: "meta", auth: "muse-login" },
    });
    const execution = await credentialExecution(
      input,
      home,
      { META_API_KEY: "unused" },
      vault,
      "muse-code",
    );
    // An API key would take priority over the sign-in.
    expect(execution.child.META_API_KEY).toBeUndefined();
    const authPath = execution.child.MUSE_AUTH_JSON_PATH ?? "";
    expect(JSON.parse(await readFile(authPath, "utf8"))).toEqual(museAuthFile(token));
    expect(execution.secrets).toContain(token);
    // The sandbox reaches only Meta's API, where Muse also mints its subscription key.
    const trial = gatewayTrial(input, "muse-code", input.modelName, execution.child);
    expect(trial.extraAllowedHosts).toEqual(["api.meta.ai"]);
    const args = solverArguments("task", "jobs", trial, "e2b", trial.extraAllowedHosts);
    expect(args.join(" ")).toContain("--agent harbor_muse:SelfBenchMuseCode");
    expect(args.join(" ")).toContain("--agent-kwarg reasoning_effort=high");
  } finally {
    await site.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("a Muse Code sign-in is only accepted as a Meta credential holding a file-stored token", () => {
  const signIn = JSON.stringify(museAuthFile(token));
  expect(
    credentialSchema.safeParse({ name: "Muse", kind: "meta", auth: "muse-login", value: signIn })
      .success,
  ).toBe(true);
  const keychain = JSON.stringify({
    schema_version: 2,
    providers: { meta: { mechanism: "oauth", storage: "keychain" } },
  });
  for (const [kind, auth, value] of [
    ["openai", "muse-login", signIn],
    ["meta", "muse-login", "meta-api-key"],
    // A macOS sign-in keeps its token in the keychain, which a sandbox cannot read.
    ["meta", "muse-login", keychain],
  ] as const)
    expect(credentialSchema.safeParse({ name: "wrong", kind, auth, value }).success).toBe(false);
  expect(
    credentialSchema.safeParse({ name: "Key", kind: "meta", value: "meta-api-key" }).success,
  ).toBe(true);
});
