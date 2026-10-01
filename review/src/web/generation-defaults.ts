import type { CredentialInfo } from "../../../src/db/credentials";
import {
  generationCredentialSupportsModel,
  generationModelLabel,
} from "../../../src/generation/settings/models";
import {
  type GenerationSettings,
  generationSandboxLabels,
  generationSettingsSchema,
} from "../../../src/generation/settings/settings";
import type { GenerationOptions } from "./GenerationFields";

export const defaultGenerationSettings: GenerationSettings = {
  authorModel: "gpt-6-sol",
  verifierModel: "gpt-6-sol",
  reasoning: "high",
  modelAccess: "managed",
  sandbox: "managed",
};

export function readGenerationSettings(key: string): GenerationSettings | undefined {
  try {
    const parsed = generationSettingsSchema.safeParse(
      JSON.parse(window.localStorage.getItem(key) ?? "null"),
    );
    if (!parsed.success) return undefined;
    // The hosted E2B UI now manages templates automatically. Old saved overrides
    // are no longer editable and must not silently override the managed template.
    return parsed.data.sandbox === "e2b"
      ? { ...parsed.data, sandboxImage: undefined }
      : parsed.data;
  } catch {
    return undefined;
  }
}

export function rememberGenerationSettings(key: string, value: GenerationSettings) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

/** Whether one stored credential can run both of the run's models. */
export function modelCredentialMatches(
  credential: Pick<CredentialInfo, "kind" | "auth">,
  models: readonly string[],
  options?: GenerationOptions,
): boolean {
  return models.every((model) =>
    generationCredentialSupportsModel(model, credential, options?.modelCatalog),
  );
}

/** Whether managed access, OpenRouter behind a platform key, can run the model. */
function managedModelOffered(model: string, options?: GenerationOptions): boolean {
  return (
    options?.modelCatalog?.some((entry) => entry.id === model && !!entry.gateways?.openrouter) ??
    true
  );
}

/** Whether the run's model access can use this model. */
function modelOffered(model: string, value: GenerationSettings, options: GenerationOptions) {
  return (
    options.models.includes(model) &&
    (value.modelAccess !== "managed" || managedModelOffered(model, options))
  );
}

/** The models the run's model access can use, with their catalog labels, for the model pickers. */
export function selectableGenerationModels(value: GenerationSettings, options: GenerationOptions) {
  return options.models
    .filter((model) => modelOffered(model, value, options))
    .map((id) => ({
      id,
      label:
        options.modelCatalog?.find((entry) => entry.id === id)?.label ?? generationModelLabel(id),
    }));
}

/** Coerces the settings onto what this deployment actually offers, filling empty defaults. */
export function withDefaultCredentials(
  value: GenerationSettings,
  options: GenerationOptions,
): GenerationSettings {
  const managedModels = options.managed?.models === true;
  const managedSandbox = options.managed?.sandbox === true;
  const fallback =
    options.models.find((model) => managedModelOffered(model, options)) ?? options.models[0];
  let next: GenerationSettings = {
    ...value,
    modelAccess: managedModels ? value.modelAccess : "credential",
    sandbox: managedSandbox || options.sandboxes.includes(value.sandbox) ? value.sandbox : "modal",
  };
  for (const field of ["authorModel", "verifierModel"] as const)
    if (!modelOffered(next[field], next, options))
      next = { ...next, [field]: fallback ?? next[field] };
  if (next.modelAccess === "credential" && !next.modelCredentialId) {
    const compatible = options.credentials.filter((item) =>
      modelCredentialMatches(item, [next.authorModel, next.verifierModel], options),
    );
    next = {
      ...next,
      modelCredentialId:
        compatible.find((item) => item.auth === "api-key")?.id ??
        compatible.find((item) => item.auth === "codex-login")?.id,
    };
  }
  const fill = (kind: string, current?: string) => {
    if (current) return current;
    return options.credentials.find((item) => item.kind === kind && item.auth === "api-key")?.id;
  };
  if (next.sandbox !== "managed")
    next = {
      ...next,
      harborEnvironment: next.harborEnvironment ?? next.sandbox,
      sandboxCredentialId: fill(next.sandbox, next.sandboxCredentialId),
    };
  if (next.sandbox !== "managed")
    next = {
      ...next,
      harborCredentialId: next.harborEnvironment
        ? fill(next.harborEnvironment, next.harborCredentialId)
        : undefined,
    };
  return next;
}

/** Short facts shown while the generation panel is collapsed. */
export function generationSettingsSummary(value: GenerationSettings): string {
  const model =
    value.authorModel === value.verifierModel
      ? generationModelLabel(value.authorModel)
      : `${generationModelLabel(value.authorModel)} / ${generationModelLabel(value.verifierModel)}`;
  const reasoning = `${value.reasoning.charAt(0).toUpperCase()}${value.reasoning.slice(1)} Reasoning`;
  if (value.modelAccess === "managed" && value.sandbox === "managed")
    return `${model} · ${reasoning} · Managed`;
  const access = value.modelAccess === "managed" ? "Managed Models" : "My Credentials";
  const sandbox =
    value.sandbox === "managed" ? "Managed Sandboxes" : generationSandboxLabels[value.sandbox];
  return `${model} · ${reasoning} · ${access} · ${sandbox}`;
}

/** Why the current selection cannot be submitted yet, for the panel's auto-expand and validity. */
export function generationSelectionProblem(
  value: GenerationSettings,
  options: GenerationOptions,
): string | undefined {
  if (!options.available) return "Generation is not available.";
  if (!generationSettingsSchema.safeParse(value).success) return "Settings are incomplete.";
  if (!modelOffered(value.authorModel, value, options)) return "Choose an author model.";
  if (!modelOffered(value.verifierModel, value, options)) return "Choose a verifier model.";
  if (value.modelAccess === "managed") {
    if (options.managed?.models !== true) return "Choose a model credential.";
  } else if (
    !options.credentials.some(
      (item) =>
        item.id === value.modelCredentialId &&
        modelCredentialMatches(item, [value.authorModel, value.verifierModel], options),
    )
  )
    return "Choose a model credential.";
  if (value.sandbox === "managed") {
    if (options.managed?.sandbox !== true) return "Choose a sandbox and its credential.";
  } else {
    if (
      !options.credentials.some(
        (item) =>
          item.id === value.sandboxCredentialId &&
          item.kind === value.sandbox &&
          item.auth === "api-key",
      )
    )
      return `Choose a ${generationSandboxLabels[value.sandbox]} credential.`;
    if (
      !options.credentials.some(
        (item) =>
          item.id === value.harborCredentialId &&
          item.kind === value.harborEnvironment &&
          item.auth === "api-key",
      )
    )
      return "Choose a Harbor verification credential.";
  }
  if (
    (value.modelAccess === "managed" || value.sandbox === "managed") &&
    options.billing?.configured === true &&
    options.billing.eligible === false
  )
    return "Set up billing to use managed models or sandboxes.";
  return undefined;
}

/** Field hints, which mention managed access only where the deployment offers it. */
export function generationHints(managed: { models: boolean; sandbox: boolean }) {
  return {
    modelAccess: managed.models
      ? "Managed runs on SelfBench's account — no credential needed, and usage is tracked per run. With My Credentials, the models run on a credential you store."
      : "The models run on a credential you store.",
    sandbox: managed.sandbox
      ? "Managed sandboxes run on SelfBench's account — nothing to configure, usage tracked per run. The other options run on a credential you store."
      : "Sandboxes run on a credential you store.",
    charges:
      managed.models || managed.sandbox
        ? "Each PR starts a separate workflow. Managed model and sandbox usage is tracked per run; stored credentials may incur charges on your own accounts."
        : "Each PR starts a separate workflow. Stored credentials may incur charges on your own accounts.",
  };
}
