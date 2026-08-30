import { z } from "zod";

export type SessionProvenanceFormat = "codex" | "claude-code" | "pi" | "generic";

const provenanceMessageBaseSchema = z.object({
  sessionId: z.string().min(1),
  messageIndex: z.number().int().nonnegative(),
  content: z.string().min(1),
});

const localProvenanceMessageSchema = provenanceMessageBaseSchema
  .extend({
    sourceType: z.enum(["codex", "claude-code", "pi", "generic"]),
    sourcePr: z.number().int().positive().optional(),
    sourceUrl: z.string().url().optional(),
  })
  .refine(
    (message) => (message.sourcePr === undefined) === (message.sourceUrl === undefined),
    "sourcePr and sourceUrl must be supplied together",
  );

export const provenanceMessageSchema = z.union([
  localProvenanceMessageSchema,
  provenanceMessageBaseSchema.extend({
    sourceType: z.literal("github-pull-request"),
    sourcePr: z.number().int().positive(),
    sourceUrl: z.string().url(),
  }),
]);

export type ProvenanceMessage = z.infer<typeof provenanceMessageSchema>;

export interface LocalSessionMetadata {
  readonly sourceType: SessionProvenanceFormat;
  readonly sessionId: string;
  readonly path: string;
  readonly modifiedAt: string;
}

export interface RepositoryProvenanceCollection {
  readonly messages: readonly ProvenanceMessage[];
  readonly sessions: readonly LocalSessionMetadata[];
}
