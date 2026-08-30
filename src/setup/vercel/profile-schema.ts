import { z } from "zod";
import { STANDARD_VERCEL_TIMEOUT_CAP_MS } from "../../sandbox/timeout.js";

export const profileNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, {
    error: "Vercel profile name must use 1-64 letters, digits, dots, underscores, or hyphens",
  });

const digestPinnedImageSchema = z
  .string()
  .regex(/^[^@\s]+@sha256:[0-9a-f]{64}$/i, "expected a digest-pinned VCR image");

export const vercelProfileSchema = z
  .object({
    teamId: z.string().trim().min(1),
    teamSlug: z.string().trim().min(1),
    teamName: z.string().trim().min(1),
    projectId: z.string().trim().min(1),
    projectName: z.string().trim().min(1),
    vcrRepository: z.string().trim().min(1),
    image: digestPinnedImageSchema,
    runtimeFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    timeoutCapMs: z.number().int().min(100).max(STANDARD_VERCEL_TIMEOUT_CAP_MS),
    capabilityCheckedAt: z.iso.datetime(),
  })
  .strict();

export type VercelProfile = z.infer<typeof vercelProfileSchema>;

export const configSchema = z
  .object({
    schemaVersion: z.literal(1),
    activeVercelProfile: profileNameSchema.optional(),
    vercelProfiles: z.record(profileNameSchema, vercelProfileSchema),
  })
  .strict();

export const credentialsSchema = z
  .object({
    schemaVersion: z.literal(1),
    vercelProfiles: z.record(
      profileNameSchema,
      z.object({ token: z.string().trim().min(1) }).strict(),
    ),
  })
  .strict();

export interface VercelProfileData {
  readonly activeVercelProfile?: string;
  readonly profiles: Readonly<Record<string, VercelProfile>>;
  readonly tokens: Readonly<Record<string, string>>;
}

export interface MutableProfileData {
  activeVercelProfile?: string;
  profiles: Record<string, VercelProfile>;
  tokens: Record<string, string>;
}
