import { randomUUID } from "node:crypto";
import { type CredentialInfo, credentialSchema } from "../../db/credentials.js";
import { orgRecords, RecordStoreError } from "../../db/encrypted-records.js";
import type { Vault } from "../../db/vault.js";

// Muse Code's `muse login`: an OAuth device-code sign-in to the Meta account behind a Muse Code
// subscription, spoken directly so no API process has to hold a Muse child open between requests.
// Muse mints its subscription key from the token itself, in the sandbox, at startup.
const ISSUER = "https://auth.meta.com";
const CLIENT_ID = "1031625952748946";
const API_BASE_URL = "https://api.meta.ai/v1";

interface MuseDeviceCode {
  verificationUrl: string;
  userCode: string;
}
export interface MuseLoginStatus {
  id: string;
  status: "waiting" | "saved" | "failed";
  expiresAt: string;
  instructions?: MuseDeviceCode;
  error?: string;
  credential?: CredentialInfo;
}
/** Sealed in the organization's encrypted records between polls. */
interface PendingLogin {
  userId: number;
  name: string;
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
}

const recordPath = (id: string) => `muse-login/${id}`;

/**
 * The `auth.json` Muse Code reads a file-stored Meta sign-in from. Its Linux build, which the
 * sandboxes run, refuses schema version 2, the version its macOS build writes for the keychain.
 */
export function museAuthFile(accessToken: string) {
  return {
    schema_version: 1,
    providers: {
      meta: {
        mechanism: "oauth",
        storage: "file",
        obtained_via: "device_code",
        access_token: accessToken,
        api_base_url: API_BASE_URL,
      },
    },
  };
}

/**
 * Short-lived, user-scoped ceremonies with no in-process state: each status poll asks Meta once
 * and, when the code is approved, saves the credential under the attempt's ID. No tokens are
 * returned to the browser.
 */
export function createMuseLogins(request: typeof fetch = fetch, lifetimeMs = 15 * 60_000) {
  const post = (path: string, fields: Record<string, string>) =>
    request(`${ISSUER}${path}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(fields).toString(),
      redirect: "manual",
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
    ): Promise<MuseLoginStatus> {
      const normalized = name.trim();
      if (!normalized || normalized.length > 80)
        throw new RecordStoreError(400, "Enter a credential name of 1–80 characters.");
      const response = await post("/oidc/device/authorization/", { client_id: CLIENT_ID }).catch(
        () => undefined,
      );
      const body = response?.ok ? await response.json().catch(() => undefined) : undefined;
      const verificationUrl = httpsUrl(body?.verification_uri_complete ?? body?.verification_uri);
      if (
        typeof body?.device_code !== "string" ||
        typeof body?.user_code !== "string" ||
        !verificationUrl
      )
        throw new RecordStoreError(502, "Could not start the Meta sign-in. Try again.");
      const id = randomUUID();
      // Meta's code lasts as long as it says, and this attempt no longer.
      const lifetime = Math.min(lifetimeMs, (Number(body.expires_in) || Infinity) * 1000);
      const expiresAt = new Date(Date.now() + lifetime).toISOString();
      const login: PendingLogin = {
        userId,
        name: normalized,
        deviceCode: body.device_code,
        userCode: body.user_code,
        verificationUrl,
        expiresAt,
      };
      await orgRecords(vault.records, orgId).write(recordPath(id), login, 0);
      return {
        id,
        status: "waiting",
        expiresAt,
        instructions: { verificationUrl, userCode: login.userCode },
      };
    },

    async status(
      vault: Vault,
      orgId: number,
      userId: number,
      id: string,
    ): Promise<MuseLoginStatus> {
      const credential = await vault.credentials.find(orgId, id);
      if (credential)
        return { id, status: "saved", expiresAt: new Date().toISOString(), credential };
      const login = await pending(vault, orgId, userId, id);
      const view = {
        id,
        expiresAt: login.expiresAt,
        instructions: { verificationUrl: login.verificationUrl, userCode: login.userCode },
      };
      const failed = async (error: string): Promise<MuseLoginStatus> => {
        await discard(vault, orgId, id);
        return { ...view, status: "failed", error };
      };
      const poll = await post("/oidc/device/token/", {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: login.deviceCode,
        client_id: CLIENT_ID,
      }).catch(() => undefined);
      // A transient failure: the next poll asks again.
      if (!poll || poll.status === 429 || poll.status >= 500) return { ...view, status: "waiting" };
      const body = await poll.json().catch(() => undefined);
      if (!poll.ok) {
        // Not approved yet, or polled sooner than Meta likes: the next poll asks again.
        if (body?.error === "authorization_pending" || body?.error === "slow_down")
          return { ...view, status: "waiting" };
        return failed(
          body?.error === "access_denied"
            ? "The sign-in was declined on Meta. Start again to retry."
            : "Sign-in was not completed. The code may have expired; try again.",
        );
      }
      const parsed = credentialSchema.safeParse({
        name: login.name,
        kind: "meta",
        auth: "muse-login",
        value:
          typeof body?.access_token === "string"
            ? JSON.stringify(museAuthFile(body.access_token))
            : "",
      });
      if (!parsed.success) return failed("Meta did not return a valid sign-in. Try again.");
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
export type MuseLogins = ReturnType<typeof createMuseLogins>;
export const museLogins = createMuseLogins();

/** Meta's verification link, only as an HTTPS address the browser can be sent to. */
function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
