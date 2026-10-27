import { expect, test } from "bun:test";
import { signInCredential } from "../../src/gateway/sign-in.js";

/** An unsigned JWT for a ChatGPT account, expiring at `exp` (seconds). */
const jwt = (exp: number) =>
  `h.${Buffer.from(
    JSON.stringify({ exp, "https://api.openai.com/auth": { chatgpt_account_id: "acct" } }),
  ).toString("base64url")}.s`;

const codexAuth = (access: string) =>
  JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      id_token: "id",
      access_token: access,
      refresh_token: "refresh-1",
      account_id: "acct",
    },
  });

test("a ChatGPT sign-in serves its plan on its access token, refreshed and saved once it expires", async () => {
  const sign = { id: "codex", auth: "codex-login" } as const;
  const fresh = jwt(Math.floor(Date.now() / 1000) + 3600);
  const unused = (async () => {
    throw new Error("no refresh needed");
  }) as never;
  expect(await signInCredential(sign, codexAuth(fresh), async () => {}, unused)).toEqual({
    apiKey: fresh,
    subscription: "openai_codex",
  });

  const renewed = jwt(Math.floor(Date.now() / 1000) + 7200);
  const requests: unknown[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return Response.json({ access_token: renewed, refresh_token: "refresh-2", expires_in: 7200 });
  }) as never;
  const saved: string[] = [];
  const save = async (value: string) => {
    saved.push(value);
  };
  const stale = codexAuth(jwt(Math.floor(Date.now() / 1000) + 60));
  // Two calls at once share one refresh: OpenAI rotates the refresh token.
  const plans = await Promise.all([
    signInCredential(sign, stale, save, fetcher),
    signInCredential(sign, stale, save, fetcher),
  ]);
  expect(plans).toEqual([
    { apiKey: renewed, subscription: "openai_codex" },
    { apiKey: renewed, subscription: "openai_codex" },
  ]);
  expect(requests).toEqual([expect.objectContaining({ refresh_token: "refresh-1" })]);
  expect(saved).toHaveLength(1);
  expect(JSON.parse(saved[0] ?? "").tokens).toMatchObject({
    id_token: "id",
    access_token: renewed,
    refresh_token: "refresh-2",
    account_id: "acct",
  });

  // A Meta sign-in is never served by the gateway.
  expect(await signInCredential({ id: "m", auth: "muse-login" }, "{}", save)).toBeUndefined();
});
