import type { ProviderCredential } from "@mupt-ai/dari-gateway";
import { refreshOAuth } from "@mupt-ai/dari-gateway/self_host/subscriptions/oauth";
import type { CredentialInfo } from "../db/credentials.js";

/** Codex's access token is refreshed once it expires within this long. */
const REFRESH_MARGIN_MS = 5 * 60_000;

/** One refresh per sign-in at a time: OpenAI rotates refresh tokens, so a second would fail. */
const refreshing = new Map<string, Promise<string>>();

/**
 * The plan the gateway serves a sign-in's model on, with its access token: a Claude sign-in's
 * one-year token as saved, and a ChatGPT sign-in's from its Codex auth.json, refreshed and saved
 * back (`save`) when it is about to expire. A Meta sign-in never reaches the gateway.
 */
export async function signInCredential(
  credential: Pick<CredentialInfo, "id" | "auth">,
  value: string,
  save: (value: string) => Promise<void>,
  fetcher: typeof fetch = fetch,
): Promise<ProviderCredential | undefined> {
  if (credential.auth === "claude-login")
    return { apiKey: value, subscription: "anthropic_claude_code" };
  if (credential.auth !== "codex-login") return undefined;
  const auth = JSON.parse(value);
  const { access_token: access, refresh_token: refreshToken, account_id } = auth.tokens ?? {};
  if (typeof access !== "string" || typeof refreshToken !== "string") return undefined;
  if (expiresAt(access) > Date.now() + REFRESH_MARGIN_MS)
    return { apiKey: access, subscription: "openai_codex" };
  let pending = refreshing.get(credential.id);
  if (!pending) {
    pending = (async () => {
      const tokens = await refreshOAuth(
        { provider: "openai_codex", refreshToken, accountId: account_id ?? null },
        { fetch: fetcher },
      );
      const tokensFile = {
        ...auth.tokens,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        account_id: tokens.accountId,
      };
      await save(
        JSON.stringify({ ...auth, tokens: tokensFile, last_refresh: new Date().toISOString() }),
      );
      return tokens.accessToken;
    })().finally(() => refreshing.delete(credential.id));
    refreshing.set(credential.id, pending);
  }
  return { apiKey: await pending, subscription: "openai_codex" };
}

/** A JWT's expiry in ms, or 0 when it has none to read. */
function expiresAt(token: string): number {
  try {
    const exp = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()).exp;
    return typeof exp === "number" ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}
