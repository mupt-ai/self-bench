import type { ProviderCredential } from "@mupt-ai/dari-gateway";
import { refreshOAuth } from "@mupt-ai/dari-gateway/self_host/subscriptions/oauth";
import type { CredentialInfo } from "../db/credentials.js";

/** Codex's access token is refreshed once it expires within this long. */
const REFRESH_MARGIN_MS = 5 * 60_000;

/** One refresh per sign-in at a time: OpenAI rotates refresh tokens, so a second would fail. */
const refreshing = new Map<string, Promise<string>>();

/**
 * Tokens OpenAI issued that could not be saved yet. OpenAI retires a refresh token once it is used,
 * so the next refresh in this process must start from these, not from the stored (retired) ones.
 */
const unsaved = new Map<string, string>();

/**
 * The plan the gateway serves a sign-in's model on, with its access token: a Claude sign-in's
 * one-year token as saved, and a ChatGPT sign-in's from its Codex auth.json, refreshed and saved
 * back (`save`) when it is about to expire. A failed save keeps the new tokens in this process and
 * is reported (`report`), so the sign-in is not locked out. A Meta sign-in never reaches the gateway.
 */
export async function signInCredential(
  credential: Pick<CredentialInfo, "id" | "auth">,
  value: string,
  save: (value: string) => Promise<void>,
  report: (error: unknown) => void = () => {},
  fetcher: typeof fetch = fetch,
): Promise<ProviderCredential | undefined> {
  if (credential.auth === "claude-login")
    return { apiKey: value, subscription: "anthropic_claude_code" };
  if (credential.auth !== "codex-login") return undefined;
  const current = unsaved.get(credential.id) ?? value;
  const auth = JSON.parse(current);
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
      const renewed = JSON.stringify({
        ...auth,
        tokens: tokensFile,
        last_refresh: new Date().toISOString(),
      });
      try {
        await save(renewed);
        unsaved.delete(credential.id);
      } catch (error) {
        unsaved.set(credential.id, renewed);
        report(error);
      }
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
