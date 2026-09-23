import { z } from "zod";
import { isDigestPinnedOciImage } from "../config/index.js";
import {
  HOSTED_EXECUTION_BACKENDS,
  HOSTED_HARBOR_ENVIRONMENTS,
  type HostedExecutionBackend,
  type HostedHarborEnvironment,
  harborEnvironmentLabels,
} from "../config/providers.js";
import { normalizeE2BTemplateReference } from "../setup/e2b/template.js";
import { generationModels } from "./models.js";

/** Sandbox choices for a generation run. "managed" runs in SelfBench's own E2B account. */
const generationSandboxes = ["managed", ...HOSTED_EXECUTION_BACKENDS] as const;
export type GenerationSandbox = (typeof generationSandboxes)[number];
export const generationSandboxLabels: Record<GenerationSandbox, string> = {
  managed: "Managed",
  modal: "Modal",
  vercel: "Vercel",
  e2b: "E2B",
};

/** The execution backend a sandbox choice runs on; managed sandboxes run on our E2B account. */
export function generationExecutionBackend(sandbox: GenerationSandbox): HostedExecutionBackend {
  return sandbox === "managed" ? "e2b" : sandbox;
}

/** The Harbor environment verification runs in for a sandbox choice. */
export function generationHarborEnvironment(
  settings: Pick<GenerationSettings, "sandbox" | "harborEnvironment">,
): HostedHarborEnvironment {
  return settings.sandbox === "managed"
    ? "e2b"
    : (settings.harborEnvironment ?? (settings.sandbox as HostedHarborEnvironment));
}

export const generationSettingsSchema = z
  .object({
    authorModel: z.enum(generationModels),
    verifierModel: z.enum(generationModels),
    reasoning: z.enum(["low", "medium", "high"]),
    /**
     * "managed" routes model calls through OpenRouter behind a platform key the server
     * holds; "credential" runs the models on the organization's own stored credential.
     */
    modelAccess: z.enum(["managed", "credential"]),
    modelCredentialId: z.uuid().optional(),
    sandbox: z.enum(generationSandboxes),
    sandboxCredentialId: z.uuid().optional(),
    sandboxImage: z.string().trim().min(1).max(512).optional(),
    harborEnvironment: z.enum(HOSTED_HARBOR_ENVIRONMENTS).optional(),
    harborCredentialId: z.uuid().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.modelAccess === "managed") {
      if (value.modelCredentialId)
        context.addIssue({
          code: "custom",
          path: ["modelCredentialId"],
          message: "Managed model access does not use a credential.",
        });
    } else {
      if (!value.modelCredentialId)
        context.addIssue({
          code: "custom",
          path: ["modelCredentialId"],
          message: "Choose a model credential.",
        });
    }
    if (value.sandbox === "managed") {
      for (const field of [
        "sandboxCredentialId",
        "sandboxImage",
        "harborEnvironment",
        "harborCredentialId",
      ] as const)
        if (value[field] !== undefined)
          context.addIssue({
            code: "custom",
            path: [field],
            message: "Managed sandboxes do not use separate credentials or verification.",
          });
      return;
    }
    if (!value.sandboxCredentialId)
      context.addIssue({
        code: "custom",
        path: ["sandboxCredentialId"],
        message: `Choose a ${generationSandboxLabels[value.sandbox]} credential.`,
      });
    if (value.sandbox === "vercel" && !isDigestPinnedOciImage(value.sandboxImage ?? ""))
      context.addIssue({
        code: "custom",
        path: ["sandboxImage"],
        message: "Vercel requires a runtime image pinned by sha256 digest.",
      });
    // E2B needs no image: the worker builds the managed SelfBench template in the user's
    // account. An explicit reference is an override for a template the user built themselves.
    if (value.sandbox === "e2b" && value.sandboxImage !== undefined) {
      try {
        if (normalizeE2BTemplateReference(value.sandboxImage).split(":")[0] === "base")
          throw new Error();
      } catch {
        context.addIssue({
          code: "custom",
          path: ["sandboxImage"],
          message: "E2B requires a prebuilt SelfBench template, not base.",
        });
      }
    } else if (value.sandbox === "modal" && value.sandboxImage !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["sandboxImage"],
        message: "Modal does not use a runtime image.",
      });
    }
    if (!value.harborEnvironment)
      context.addIssue({
        code: "custom",
        path: ["harborEnvironment"],
        message: "Choose a Harbor verification environment.",
      });
    else if (!value.harborCredentialId)
      context.addIssue({
        code: "custom",
        path: ["harborCredentialId"],
        message: `Choose a ${harborEnvironmentLabels[value.harborEnvironment]} credential for Harbor verification.`,
      });
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
