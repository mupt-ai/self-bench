import { z } from "zod";
import {
  HOSTED_EXECUTION_BACKENDS,
  HOSTED_HARBOR_ENVIRONMENTS,
  type HostedExecutionBackend,
  type HostedHarborEnvironment,
  harborEnvironmentLabels,
} from "../../contracts/config/providers.js";
import { modelIdPattern } from "../../contracts/models.js";
import { gatewayIds } from "../../gateways/index.js";
import { sandboxImageIssue } from "../../sandbox/runtime-image-rules.js";

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

/**
 * The Harbor environment verification runs in for a sandbox choice. Managed runs verify
 * wherever the deployment's platform accounts allow (`managedHarborEnvironment`).
 */
export function generationHarborEnvironment(
  settings: Pick<GenerationSettings, "sandbox" | "harborEnvironment">,
  managed: HostedHarborEnvironment,
): HostedHarborEnvironment {
  return settings.sandbox === "managed"
    ? managed
    : (settings.harborEnvironment ?? (settings.sandbox as HostedHarborEnvironment));
}

export const generationSettingsSchema = z
  .object({
    /** Catalog ids; the catalog changes with the gateways, so submission checks they exist. */
    authorModel: z.string().regex(modelIdPattern),
    verifierModel: z.string().regex(modelIdPattern),
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
    const imageIssue = sandboxImageIssue(value.sandbox, value.sandboxImage);
    if (imageIssue)
      context.addIssue({ code: "custom", path: ["sandboxImage"], message: imageIssue });
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

const rate = z.number().nonnegative();
/** $ per million tokens. */
const modelRatesSchema = z
  .object({ input: rate, output: rate, cacheRead: rate, cacheWrite: rate })
  .strict();
export type GenerationModelRates = z.infer<typeof modelRatesSchema>;

/**
 * Pi's models.json for a gateway model, as JSON: the whole entry for a Pi whose catalog lacks the
 * model, and only its thinking overrides for one that lists it.
 */
export const piModelsSchema = z
  .object({ models: z.string().min(1), overrides: z.string().min(1).optional() })
  .strict();
export type PiModelsFiles = z.infer<typeof piModelsSchema>;

/**
 * One stage's model as submission resolved it. The gateways can drop a model while a run is
 * underway, so the run keeps what it was accepted with: the Pi provider and model id, Pi's
 * models.json from the gateway's listing, and OpenRouter's rates, which billing falls back to
 * when the model no longer has live ones.
 */
const generationRouteSchema = z
  .object({
    provider: z.enum(["openai", "openai-codex", "anthropic", ...gatewayIds]),
    model: z.string().min(1),
    piModels: piModelsSchema.optional(),
    rates: modelRatesSchema.optional(),
  })
  .strict();
export type GenerationRoute = z.infer<typeof generationRouteSchema>;

export const generationReferenceSchema = z
  .object({
    ownerId: z.number().int().positive(),
    orgId: z.number().int().positive().optional(),
    repoId: z.number().int().positive(),
    settings: generationSettingsSchema,
    /** Absent on runs submitted before routes were resolved at submission. */
    routes: z
      .object({ author: generationRouteSchema, verifier: generationRouteSchema })
      .strict()
      .optional(),
  })
  .strict();
export type GenerationReference = z.infer<typeof generationReferenceSchema>;
