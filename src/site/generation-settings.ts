import { z } from "zod";
import { isDigestPinnedOciImage } from "../config.js";
import { EXECUTION_BACKENDS, executionBackendLabels, HARBOR_ENVIRONMENTS } from "../providers.js";
import { normalizeE2BTemplateReference } from "../setup/e2b/template.js";

export const generationModels = [
  "gpt-5.6-sol",
  "gpt-6-astra",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
] as const;
export const generationSettingsSchema = z
  .object({
    authorModel: z.enum(generationModels),
    verifierModel: z.enum(generationModels),
    reasoning: z.enum(["low", "medium", "high"]),
    sandbox: z.enum(EXECUTION_BACKENDS),
    modelCredentialId: z.uuid(),
    sandboxCredentialId: z.uuid().optional(),
    sandboxImage: z.string().trim().min(1).max(512).optional(),
    harborEnvironment: z.enum(HARBOR_ENVIRONMENTS).optional(),
    harborCredentialId: z.uuid().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.sandbox !== "docker" && !value.sandboxCredentialId)
      context.addIssue({
        code: "custom",
        path: ["sandboxCredentialId"],
        message: `Choose a ${executionBackendLabels[value.sandbox]} credential.`,
      });
    const hosted = value.sandbox === "e2b" || value.sandbox === "vercel";
    if (!hosted) {
      if (value.harborEnvironment || value.harborCredentialId || value.sandboxImage)
        context.addIssue({
          code: "custom",
          message:
            "Separate verification and runtime settings are only supported for E2B and Vercel generation.",
        });
      return;
    }
    if (!value.harborEnvironment)
      context.addIssue({
        code: "custom",
        path: ["harborEnvironment"],
        message: "Choose Docker or Modal for Harbor verification.",
      });
    if (value.harborEnvironment === "modal" && !value.harborCredentialId)
      context.addIssue({
        code: "custom",
        path: ["harborCredentialId"],
        message: "Choose a Modal credential for Harbor verification.",
      });
    if (value.sandbox === "vercel" && !isDigestPinnedOciImage(value.sandboxImage ?? ""))
      context.addIssue({
        code: "custom",
        path: ["sandboxImage"],
        message: "Vercel requires a runtime image pinned by sha256 digest.",
      });
    if (value.sandbox === "e2b") {
      try {
        if (normalizeE2BTemplateReference(value.sandboxImage ?? "").split(":")[0] === "base")
          throw new Error();
      } catch {
        context.addIssue({
          code: "custom",
          path: ["sandboxImage"],
          message: "E2B requires a prebuilt SelfBench template, not base.",
        });
      }
    }
  });
export type GenerationSettings = z.infer<typeof generationSettingsSchema>;

export const generationReferenceSchema = z
  .object({
    ownerId: z.number().int().positive(),
    orgId: z.number().int().positive().optional(),
    repoId: z.number().int().positive(),
    settings: generationSettingsSchema,
  })
  .strict();
export type GenerationReference = z.infer<typeof generationReferenceSchema>;
