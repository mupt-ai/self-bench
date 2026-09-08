import { z } from "zod";

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
    sandbox: z.enum(["docker", "modal"]),
    modelCredentialId: z.uuid(),
    sandboxCredentialId: z.uuid().optional(),
  })
  .strict()
  .refine((value) => value.sandbox !== "modal" || !!value.sandboxCredentialId, {
    message: "Choose a Modal credential.",
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
