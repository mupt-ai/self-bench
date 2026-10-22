import type { BillingStore } from "../../db/billing.js";
import type { Vault } from "../../db/vault.js";
import { managedBillingRefusal } from "../../generation/billing/eligibility.js";
import { managedOffer } from "../../generation/billing/managed.js";
import {
  checkGenerationCredentials,
  GENERATION_REQUIRED,
  generationRoutes,
} from "../../generation/settings/credentials.js";
import {
  type GenerationReference,
  generationSettingsSchema,
} from "../../generation/settings/settings.js";

type Requested =
  | { readonly generation?: GenerationReference }
  | { readonly status: number; readonly body: Record<string, unknown> };

/**
 * A task start's generation settings, checked against the workspace's credentials and billing,
 * with both stages' models resolved; or the refusal to send. Undefined settings are allowed only
 * where the site stores no credentials.
 */
export async function requestedGeneration(
  options: { readonly vault?: Vault; readonly billing?: BillingStore },
  scope: { readonly orgId: number; readonly repoId: number },
  raw: unknown,
): Promise<Requested> {
  const parsed = raw === undefined ? undefined : generationSettingsSchema.safeParse(raw);
  if (parsed && !parsed.success)
    return {
      status: 400,
      body: { error: "Choose valid generation models, reasoning, sandbox, and credentials." },
    };
  const generation: GenerationReference | undefined = parsed?.success
    ? { ownerId: scope.orgId, orgId: scope.orgId, repoId: scope.repoId, settings: parsed.data }
    : undefined;
  if (!generation)
    return options.vault ? { status: 400, body: { error: GENERATION_REQUIRED } } : {};
  if (!options.vault)
    return { status: 503, body: { error: "Generation credential storage is not configured." } };
  try {
    await checkGenerationCredentials(
      options.vault.credentials,
      scope.orgId,
      generation.settings,
      managedOffer(),
    );
    generation.routes = await generationRoutes(
      options.vault.credentials,
      scope.orgId,
      generation.settings,
    );
  } catch (error) {
    return {
      status: 400,
      body: { error: error instanceof Error ? error.message : "Credential unavailable" },
    };
  }
  const refusal = managedBillingRefusal(
    generation.settings,
    options.billing ? await options.billing.status(scope.orgId) : undefined,
  );
  return refusal ? { status: 403, body: refusal } : { generation };
}
