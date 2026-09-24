import { randomUUID } from "node:crypto";
import { type CredentialInfo, credentialSchema } from "../../db/credentials.js";
import { orgRecords, RecordStoreError } from "../../db/encrypted-records.js";
import type { Vault } from "../../db/vault.js";

// Codex CLI's device-code sign-in (codex-rs/login/src/device_code_auth.rs), spoken directly so
// no API process has to hold a Codex child open between requests.
const ISSUER = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const VERIFICATION_URL = `${ISSUER}/codex/device`;

interface CodexDeviceCode {
  verificationUrl: string;
  userCode: string;
}
export interface CodexLoginStatus {
  id: string;
  status: "waiting" | "saved" | "failed";
  expiresAt: string;
  instructions?: CodexDeviceCode;
  error?: string;
  credential?: CredentialInfo;
}
/** Sealed in the organization's encrypted records between polls. */
interface PendingLogin {
  userId: number;
  name: string;
  deviceAuthId: string;
  userCode: string;
  expiresAt: string;
}

const recordPath = (id: string) => `codex-login/${id}`;

/**
 * Short-lived, user-scoped ceremonies with no in-process state: each status poll asks OpenAI
 * once and, when the code is approved, saves the credential under the attempt's ID. No tokens
 * are returned to the browser.
 */
export function createCodexLogins(request: typeof fetch = fetch, lifetimeMs = 15 * 60_000) {
  const post = (path: string, body: string, contentType: string) =>
    request(`${ISSUER}${path}`, {
      method: "POST",
      headers: { "content-type": contentType },
      body,
      signal: AbortSignal.timeout(15_000),
    });
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
    ): Promise<CodexLoginStatus> {
      const normalized = name.trim();
      if (!normalized || normalized.length > 80)
        throw new RecordStoreError(400, "Enter a credential name of 1–80 characters.");
      const response = await post(
        "/api/accounts/deviceauth/usercode",
        JSON.stringify({ client_id: CLIENT_ID }),
        "application/json",
      ).catch(() => undefined);
      const body = response?.ok ? await response.json().catch(() => undefined) : undefined;
      const userCode = body?.user_code ?? body?.usercode;
      if (typeof body?.device_auth_id !== "string" || typeof userCode !== "string")
        throw new RecordStoreError(
          502,
          "Could not start device sign-in. Check that device code login is enabled in your ChatGPT security settings, then try again.",
        );
      const id = randomUUID();
      const expiresAt = new Date(Date.now() + lifetimeMs).toISOString();
      const login: PendingLogin = {
        userId,
        name: normalized,
        deviceAuthId: body.device_auth_id,
        userCode,
        expiresAt,
      };
      await orgRecords(vault.records, orgId).write(recordPath(id), login, 0);
      return {
        id,
        status: "waiting",
        expiresAt,
        instructions: { verificationUrl: VERIFICATION_URL, userCode },
      };
    },

    async status(
      vault: Vault,
      orgId: number,
      userId: number,
      id: string,
    ): Promise<CodexLoginStatus> {
      const credential = await vault.credentials.find(orgId, id);
      if (credential)
        return { id, status: "saved", expiresAt: new Date().toISOString(), credential };
      const login = await pending(vault, orgId, userId, id);
      const view = {
        id,
        expiresAt: login.expiresAt,
        instructions: { verificationUrl: VERIFICATION_URL, userCode: login.userCode },
      };
      const failed = async (error: string): Promise<CodexLoginStatus> => {
        await discard(vault, orgId, id);
        return { ...view, status: "failed", error };
      };
      const poll = await post(
        "/api/accounts/deviceauth/token",
        JSON.stringify({ device_auth_id: login.deviceAuthId, user_code: login.userCode }),
        "application/json",
      ).catch(() => undefined);
      // Not approved yet (403/404), or a transient network error: the next poll asks again.
      if (!poll || poll.status === 403 || poll.status === 404)
        return { ...view, status: "waiting" };
      const code = poll.ok ? await poll.json().catch(() => undefined) : undefined;
      if (typeof code?.authorization_code !== "string" || typeof code?.code_verifier !== "string")
        return failed("Sign-in was not completed. The code may have expired; try again.");
      const exchange = await post(
        "/oauth/token",
        new URLSearchParams({
          grant_type: "authorization_code",
          code: code.authorization_code,
          redirect_uri: `${ISSUER}/deviceauth/callback`,
          client_id: CLIENT_ID,
          code_verifier: code.code_verifier,
        }).toString(),
        "application/x-www-form-urlencoded",
      ).catch(() => undefined);
      const tokens = exchange?.ok ? await exchange.json().catch(() => undefined) : undefined;
      const parsed = credentialSchema.safeParse({
        name: login.name,
        kind: "openai",
        auth: "codex-login",
        value: JSON.stringify(codexAuthFile(tokens ?? {})),
      });
      if (typeof tokens?.id_token !== "string" || !parsed.success)
        return failed("Codex did not return a valid ChatGPT sign-in. Try again.");
      try {
        // The attempt ID doubles as the credential ID, so a concurrent poll never duplicates it.
        const saved = await vault.credentials.create(orgId, parsed.data, {}, id);
        await discard(vault, orgId, id);
        return { ...view, status: "saved", credential: saved };
      } catch {
        return failed("Sign-in completed, but saving failed. Start a new sign-in.");
      }
    },

    async cancel(vault: Vault, orgId: number, userId: number, id: string): Promise<void> {
      await pending(vault, orgId, userId, id);
      await discard(vault, orgId, id);
    },
  };
}
export type CodexLogins = ReturnType<typeof createCodexLogins>;
export const codexLogins = createCodexLogins();

/** The `auth.json` Codex itself writes after a ChatGPT sign-in. */
function codexAuthFile(tokens: {
  id_token?: unknown;
  access_token?: unknown;
  refresh_token?: unknown;
}) {
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: tokens.id_token,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      account_id: chatgptAccountId(tokens.id_token),
    },
    last_refresh: new Date().toISOString(),
  };
}

function chatgptAccountId(idToken: unknown): string | null {
  if (typeof idToken !== "string") return null;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString());
    const account = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof account === "string" ? account : null;
  } catch {
    return null;
  }
}
