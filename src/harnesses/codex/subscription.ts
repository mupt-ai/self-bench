import { z } from "zod";

const authSchema = z.object({
  tokens: z.object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    account_id: z.string().min(1).optional(),
  }),
});
const claimsSchema = z.object({
  exp: z.number().positive(),
  "https://api.openai.com/auth": z.object({ chatgpt_account_id: z.string().min(1) }).optional(),
});

interface SubscriptionTokens {
  access: string;
  refresh: string;
  /** Unix seconds. */
  expires: number;
  accountId: string;
}

/** The OAuth tokens in a saved Codex login, with the expiry and account its access token names. */
function subscriptionTokens(raw: string): SubscriptionTokens {
  try {
    const { tokens } = authSchema.parse(JSON.parse(raw));
    const payload = tokens.access_token.split(".")[1];
    if (!payload) throw new Error();
    const claims = claimsSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString()));
    const accountId =
      tokens.account_id ?? claims["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (!accountId) throw new Error();
    return {
      access: tokens.access_token,
      refresh: tokens.refresh_token,
      expires: claims.exp,
      accountId,
    };
  } catch {
    throw new Error("ChatGPT sign-in is invalid. Reconnect it in Credentials.");
  }
}

/** Adapt the saved Codex login to the OAuth format consumed by Pi in generation sandboxes. */
export function generationSubscriptionAuth(raw: string): string {
  const { access, refresh, expires, accountId } = subscriptionTokens(raw);
  return JSON.stringify({
    "openai-codex": { type: "oauth", access, refresh, expires: expires * 1000, accountId },
  });
}

/** Adapt the saved Codex login to the auth file of LiteLLM's chatgpt provider. */
export function litellmSubscriptionAuth(raw: string): string {
  const { access, refresh, expires, accountId } = subscriptionTokens(raw);
  return JSON.stringify({
    access_token: access,
    refresh_token: refresh,
    expires_at: expires,
    account_id: accountId,
  });
}
