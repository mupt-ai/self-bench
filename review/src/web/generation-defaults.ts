import type { CredentialInfo } from "../../../src/db/credentials";
import {
  generationModelCredentialKinds,
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
  ...models: readonly string[]
): boolean {
  if (credential.auth === "codex-login") return models.every((model) => model.startsWith("gpt-"));
  if (credential.auth !== "api-key" || credential.kind === "custom") return false;
  return models.every((model) => generationModelCredentialKinds(model).includes(credential.kind));
}

/** Coerces the settings onto what this deployment actually offers, filling empty defaults. */
export function withDefaultCredentials(
  value: GenerationSettings,
  options: GenerationOptions,
): GenerationSettings {
  const managedModels = options.managed?.models === true;
  const managedSandbox = options.managed?.sandbox === true;
  let next: GenerationSettings = {
    ...value,
    modelAccess: managedModels ? value.modelAccess : "credential",
    sandbox: managedSandbox || options.sandboxes.includes(value.sandbox) ? value.sandbox : "modal",
  };
  if (next.modelAccess === "credential" && !next.modelCredentialId) {
    const compatible = options.credentials.filter((item) =>
      modelCredentialMatches(item, next.authorModel, next.verifierModel),
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
  if (!options.models.includes(value.authorModel)) return "Choose an author model.";
  if (!options.models.includes(value.verifierModel)) return "Choose a verifier model.";
  if (value.modelAccess === "managed") {
    if (options.managed?.models !== true) return "Choose a model credential.";
  } else if (
    !options.credentials.some(
      (item) =>
        item.id === value.modelCredentialId &&
        modelCredentialMatches(item, value.authorModel, value.verifierModel),
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
