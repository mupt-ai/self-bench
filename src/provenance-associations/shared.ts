import { z } from "zod";
import type { SessionProvenanceFormat } from "../provenance.js";

export const localSourceTypeSchema = z.enum(["pi", "claude-code", "codex"]);
export type LocalSourceType = z.infer<typeof localSourceTypeSchema>;

export const associationMessageSchema = z
  .object({
    sourceType: localSourceTypeSchema,
    sessionId: z.string().min(1),
    messageIndex: z.number().int().nonnegative(),
    contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export const provenanceAssociationManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    repository: z.string().regex(/^[^/]+\/[^/]+$/),
    sourcePr: z.number().int().positive(),
    sourceUrl: z.string().url(),
    messages: z.array(associationMessageSchema).min(1),
  })
  .strict();

export type ProvenanceAssociationManifest = z.infer<typeof provenanceAssociationManifestSchema>;

export interface MergedPullRequest {
  readonly sourcePr: number;
  readonly sourceUrl: string;
}

export function parseSessionSelector(value: string): string {
  const separator = value.indexOf(":");
  if (separator < 1 || separator === value.length - 1) {
    throw new Error(`invalid session selector ${JSON.stringify(value)}; expected TYPE:SESSION_ID`);
  }
  const sourceType = localSourceTypeSchema.parse(value.slice(0, separator));
  return sessionSelector(sourceType, value.slice(separator + 1));
}

export function sessionSelector(sourceType: LocalSourceType, sessionId: string): string {
  return `${sourceType}:${sessionId}`;
}

export function messageKey(
  sourceType: SessionProvenanceFormat | "github-pull-request",
  sessionId: string,
  messageIndex: number,
): string {
  return `${sourceType}:${sessionId}:${messageIndex}`;
}

export function compareAssociationMessages(
  left: z.infer<typeof associationMessageSchema>,
  right: z.infer<typeof associationMessageSchema>,
): number {
  return (
    left.sourceType.localeCompare(right.sourceType) ||
    left.sessionId.localeCompare(right.sessionId) ||
    left.messageIndex - right.messageIndex
  );
}

export function isLocalSourceType(value: string): value is LocalSourceType {
  return value === "pi" || value === "claude-code" || value === "codex";
}
