import { z } from "zod";
import { modelIdPattern } from "../contracts/models.js";

export const sandboxKinds = ["e2b", "modal", "daytona", "vercel"] as const;

export const isSandboxKind = (kind: string): kind is (typeof sandboxKinds)[number] =>
  (sandboxKinds as readonly string[]).includes(kind);

/** Muse Code's auth.json holding a Meta sign-in's token in the file, as SelfBench writes it. */
export function museSignIn(value: string): boolean {
  try {
    const meta = JSON.parse(value).providers?.meta;
    return meta?.mechanism === "oauth" && meta.storage === "file" && !!meta.access_token;
  } catch {
    return false;
  }
}

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
