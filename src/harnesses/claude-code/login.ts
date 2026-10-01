import { createHash, randomBytes, randomUUID } from "node:crypto";
import { type CredentialInfo, credentialSchema } from "../../db/credentials.js";
import { orgRecords, RecordStoreError } from "../../db/encrypted-records.js";
import type { Vault } from "../../db/vault.js";

// Claude Code's `claude setup-token`: a Claude subscription sign-in scoped to inference, whose
// one-year token Claude Code reads from CLAUDE_CODE_OAUTH_TOKEN. Anthropic shows the code on its
// own callback page, so the user pastes it back instead of us hosting a redirect.
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const TOKEN_LIFETIME_SECONDS = 365 * 24 * 60 * 60;

export interface ClaudeLoginStatus {
  id: string;
  status: "waiting" | "saved";
  expiresAt: string;
  authorizeUrl?: string;
  credential?: CredentialInfo;
}
/** Sealed in the organization's encrypted records until the code comes back. */
interface PendingLogin {
  userId: number;
  name: string;
  verifier: string;
  state: string;
  expiresAt: string;
}

const recordPath = (id: string) => `claude-login/${id}`;

function authorizeUrl(login: PendingLogin): string {
  return `${AUTHORIZE_URL}?${new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: "user:inference",
    code_challenge: createHash("sha256").update(login.verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: login.state,
  })}`;
}

/** Anthropic's page shows `code#state`; a pasted callback URL is accepted too. */
function parseCode(input: string): { code: string; state: string } {
  const value = input.trim();
  try {
    const url = new URL(value);
    return { code: url.searchParams.get("code") ?? "", state: url.searchParams.get("state") ?? "" };
  } catch {}
  const [code = "", state = ""] = value.split("#", 2);
  return { code, state };
}

/**
 * Short-lived, user-scoped ceremonies with no in-process state: `start` seals the PKCE verifier,
 * and `complete` exchanges the pasted code and saves the credential under the attempt's ID. No
 * tokens are returned to the browser.
 */
export function createClaudeLogins(request: typeof fetch = fetch, lifetimeMs = 15 * 60_000) {
  const pending = async (vault: Vault, orgId: number, userId: number, id: string) => {
    const record = await orgRecords(vault.records, orgId).read<PendingLogin>(recordPath(id));
    if (
      !record ||
      record.value.userId !== userId ||
      Date.parse(record.value.expiresAt) <= Date.now()
    )
      throw new RecordStoreError(410, "This sign-in has expired. Start a new sign-in.");
    return record.value;
  };
  const discard = (vault: Vault, orgId: number, id: string) =>
    orgRecords(vault.records, orgId).destroy(recordPath(id));

  return {
    async start(
      vault: Vault,
      orgId: number,
      userId: number,
      name: string,
    ): Promise<ClaudeLoginStatus> {
      const normalized = name.trim();
      if (!normalized || normalized.length > 80)
        throw new RecordStoreError(400, "Enter a credential name of 1–80 characters.");
      const id = randomUUID();
      const login: PendingLogin = {
        userId,
        name: normalized,
        verifier: randomBytes(32).toString("base64url"),
        state: randomBytes(32).toString("base64url"),
        expiresAt: new Date(Date.now() + lifetimeMs).toISOString(),
      };
      await orgRecords(vault.records, orgId).write(recordPath(id), login, 0);
      return {
        id,
        status: "waiting",
        expiresAt: login.expiresAt,
        authorizeUrl: authorizeUrl(login),
      };
    },

    async complete(
      vault: Vault,
      orgId: number,
      userId: number,
      id: string,
      input: string,
    ): Promise<ClaudeLoginStatus> {
      const existing = await vault.credentials.find(orgId, id);
      if (existing)
        return {
          id,
          status: "saved",
          expiresAt: new Date().toISOString(),
          credential: existing,
        };
      const login = await pending(vault, orgId, userId, id);
      const { code, state } = parseCode(input);
      if (!code || state !== login.state)
        throw new RecordStoreError(
          400,
          "That code is not from this sign-in. Copy the whole code Anthropic shows and try again.",
        );
      const exchange = await request(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT_URI,
          client_id: CLIENT_ID,
          code_verifier: login.verifier,
          state: login.state,
          expires_in: TOKEN_LIFETIME_SECONDS,
        }),
        signal: AbortSignal.timeout(15_000),
      }).catch(() => undefined);
      if (!exchange || exchange.status === 429 || exchange.status >= 500)
        throw new RecordStoreError(502, "Could not reach Anthropic. Try again.");
      // The verifier stays sealed, so a rejected code can be retried with a fresh one.
      const tokens = exchange.ok ? await exchange.json().catch(() => undefined) : undefined;
      const parsed = credentialSchema.safeParse({
        name: login.name,
        kind: "anthropic",
        auth: "claude-login",
        value: tokens?.access_token,
      });
      if (!parsed.success)
        throw new RecordStoreError(
          400,
          "Anthropic did not accept this code. Open the sign-in link again for a new code.",
        );
      // A sign-in cancelled while Anthropic answered must not save.
      await pending(vault, orgId, userId, id);
      let saved: CredentialInfo;
      try {
        // The attempt ID doubles as the credential ID, so a repeated submit never duplicates it.
        saved = await vault.credentials.create(orgId, parsed.data, {}, id);
      } catch (error) {
        const limit = error instanceof Error && error.message === "Credential limit reached";
        throw new RecordStoreError(
          limit ? 409 : 500,
          limit
            ? "Signed in, but this organization has reached its credential limit. Delete a credential and sign in again."
            : "Sign-in completed, but saving failed. Start a new sign-in.",
        );
      }
      // The credential exists now; a leftover record only expires.
      await discard(vault, orgId, id).catch(() => undefined);
      return { id, status: "saved", expiresAt: login.expiresAt, credential: saved };
    },

    async cancel(vault: Vault, orgId: number, userId: number, id: string): Promise<void> {
      await pending(vault, orgId, userId, id);
      await discard(vault, orgId, id);
    },
  };
}
export type ClaudeLogins = ReturnType<typeof createClaudeLogins>;
export const claudeLogins = createClaudeLogins();
