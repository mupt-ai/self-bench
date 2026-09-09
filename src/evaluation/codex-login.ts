import { randomUUID } from "node:crypto";
import type { CredentialInfo } from "./account.js";
import {
  type CodexDeviceCode,
  type CodexLoginProcess,
  startCodexLogin,
} from "./codex-login-process.js";
import { credentialSchema, saveCredential } from "./credentials.js";
import { type EncryptedRecordStore, RecordStoreError } from "./encrypted-records.js";
import { orgRecords } from "./org-records.js";

export interface CodexLoginStatus {
  id: string;
  status: "starting" | "waiting" | "ready" | "saving" | "saved" | "failed";
  expiresAt: string;
  instructions?: CodexDeviceCode;
  error?: string;
  credential?: CredentialInfo;
}
interface Attempt {
  orgId: number;
  userId: number;
  name: string;
  view: CodexLoginStatus;
  process?: CodexLoginProcess;
  auth?: string;
  saving?: Promise<CredentialInfo>;
  timer: ReturnType<typeof setTimeout>;
}

/** Short-lived, user-scoped ceremonies. No tokens are returned to the browser. */
export function createCodexLogins(start = startCodexLogin, lifetimeMs = 15 * 60_000) {
  const attempts = new Map<string, Attempt>();
  const startingUsers = new Set<number>();
  const cancel = async (id: string) => {
    const attempt = attempts.get(id);
    if (!attempt) return;
    attempts.delete(id);
    clearTimeout(attempt.timer);
    delete attempt.auth;
    await attempt.process?.close();
  };
  const get = (orgId: number, userId: number, id: string) => {
    const attempt = attempts.get(id);
    if (!attempt || attempt.orgId !== orgId || attempt.userId !== userId)
      throw new RecordStoreError(410, "This sign-in has expired. Start a new sign-in.");
    return attempt;
  };
  return {
    async start(orgId: number, userId: number, name: string) {
      if (startingUsers.has(userId))
        throw new RecordStoreError(429, "A sign-in is already starting. Please wait.");
      startingUsers.add(userId);
      try {
        const normalized = name.trim();
        if (!normalized || normalized.length > 80)
          throw new RecordStoreError(400, "Enter a credential name of 1–80 characters.");
        const previous = [...attempts.values()].find((attempt) => attempt.userId === userId);
        if (previous) {
          if (previous.view.status === "saving")
            throw new RecordStoreError(409, "Your sign-in is being saved. Please wait.");
          await cancel(previous.view.id);
        }
        if (attempts.size >= 32)
          throw new RecordStoreError(429, "Too many sign-ins in progress. Try again shortly.");
        const id = randomUUID();
        const view: CodexLoginStatus = {
          id,
          status: "starting",
          expiresAt: new Date(Date.now() + lifetimeMs).toISOString(),
        };
        const timer = setTimeout(() => {
          void cancel(id);
        }, lifetimeMs);
        timer.unref();
        const attempt: Attempt = { orgId, userId, name: normalized, view, timer };
        attempts.set(id, attempt);
        void (async () => {
          try {
            const process = await start();
            attempt.process = process;
            if (!attempts.has(id)) {
              await process.close();
              return;
            }
            view.instructions = await process.instructions;
            view.status = "waiting";
            const auth = await process.auth;
            if (!attempts.has(id)) return;
            const draft = credentialSchema.parse({
              name: normalized,
              kind: "openai",
              auth: "codex-login",
              value: auth,
            });
            attempt.auth = draft.value;
            view.status = "ready";
          } catch (cause) {
            if (attempts.has(id)) {
              view.status = "failed";
              view.error =
                cause instanceof Error && cause.name !== "ZodError"
                  ? cause.message
                  : "Codex did not return a valid ChatGPT sign-in. Try again.";
            }
          } finally {
            const process = attempt.process;
            delete attempt.process;
            await process?.close();
          }
        })();
        return { ...view };
      } finally {
        startingUsers.delete(userId);
      }
    },
    status(orgId: number, userId: number, id: string): CodexLoginStatus {
      return { ...get(orgId, userId, id).view };
    },
    async complete(orgId: number, userId: number, id: string, records: EncryptedRecordStore) {
      const attempt = get(orgId, userId, id);
      if (attempt.view.credential) return attempt.view.credential;
      if (attempt.saving) return attempt.saving;
      if (!attempt.auth || attempt.view.status !== "ready")
        throw new RecordStoreError(409, "Finish signing in with ChatGPT first.");
      attempt.view.status = "saving";
      // A migration key also makes retries safe after a partial storage write.
      attempt.saving = saveCredential(
        orgRecords(records, orgId),
        orgId,
        {
          name: attempt.name,
          kind: "openai",
          auth: "codex-login",
          value: attempt.auth,
        },
        {},
        `codex-login:${id}`,
      )
        .then((credential) => {
          delete attempt.auth;
          attempt.view.credential = credential;
          attempt.view.status = "saved";
          return credential;
        })
        .catch(() => {
          attempt.view.status = "ready";
          throw new RecordStoreError(
            503,
            "Sign-in completed, but saving failed. Retry saving your credential.",
          );
        })
        .finally(() => {
          delete attempt.saving;
        });
      return attempt.saving;
    },
    async cancel(orgId: number, userId: number, id: string) {
      const attempt = get(orgId, userId, id);
      if (attempt.saving) await attempt.saving;
      await cancel(id);
    },
    async close() {
      await Promise.all([...attempts.keys()].map(cancel));
    },
  };
}
export type CodexLogins = ReturnType<typeof createCodexLogins>;
export const codexLogins = createCodexLogins();
