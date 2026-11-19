import { z } from "zod";
import { modelIdPattern } from "../contracts/models.js";
import { readDariLinkSecret } from "../gateway/dari-link/connection.js";

/**
 * An API key (sandboxes, and the model keys generation and custom endpoints use), or a Dari Link
 * grant: the user's own plans and API keys, connected to Dari, which SelfBench may use until the
 * user revokes it (gateway/dari-link). Connect with Dari is the only way to connect a plan.
 */
export const connectableAuths = ["api-key", "dari-link"] as const;

/**
 * Every auth a credential row or a past run may record: also the provider sign-ins (Codex's
 * ChatGPT, Claude Code's Claude, Muse Code's Meta) SelfBench took before Connect with Dari, which
 * results and cost accounting still read. Nothing creates or runs them any more.
 */
export const credentialAuths = [
  ...connectableAuths,
  "codex-login",
  "claude-login",
  "muse-login",
] as const;

/** A Dari Link grant as Connect with Dari saves it: one credential, holding the grant's tokens. */
export function dariLinkGrant(draft: { kind: string; value: string }): boolean {
  return draft.kind === "dari-link" && !!readDariLinkSecret(draft.value);
}

export const sandboxKinds = ["e2b", "modal", "daytona", "vercel"] as const;

export const isSandboxKind = (kind: string): kind is (typeof sandboxKinds)[number] =>
  (sandboxKinds as readonly string[]).includes(kind);

export interface CredentialSecret {
  value: string;
  tokenId?: string;
  teamId?: string;
  projectId?: string;
}

/**
 * A custom endpoint's saved model IDs (`shift-1`, `switchyard`), so the Run page offers each with
 * its credential instead of a typed ID. Trimmed, blank and repeated entries dropped, at most 20.
 */
export const savedModelsSchema = z
  .array(z.string().trim())
  .max(20)
  .transform((models) => [...new Set(models.filter(Boolean))])
  .pipe(z.array(z.string().regex(modelIdPattern, "Model IDs use letters, numbers and . _ : / -")));
