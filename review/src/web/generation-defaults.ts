import type { CredentialInfo } from "../../../src/evaluation/account";
import {
  generationModelCredentialKinds,
  generationModelLabel,
} from "../../../src/site/generation-models";
import {
  type GenerationSettings,
  generationSandboxLabels,
  generationSettingsSchema,
} from "../../../src/site/generation-settings";
import type { GenerationOptions } from "./GenerationFields";

export const defaultGenerationSettings: GenerationSettings = {
  authorModel: "gpt-5.6-sol",
  verifierModel: "gpt-5.6-sol",
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
    next = { ...next, sandboxCredentialId: fill(next.sandbox, next.sandboxCredentialId) };
  if (next.sandbox === "e2b" || next.sandbox === "vercel")
    next = {
      ...next,
      harborCredentialId: next.harborEnvironment
        ? fill(next.harborEnvironment, next.harborCredentialId)
        : undefined,
    };
  return next;
}

/** The one-line summary shown while the advanced panel is collapsed. */
export function generationSettingsSummary(value: GenerationSettings): string {
  const models =
    value.authorModel === value.verifierModel
      ? `${generationModelLabel(value.authorModel)} both authors and verifies each task`
      : `${generationModelLabel(value.authorModel)} authors and ${generationModelLabel(value.verifierModel)} verifies each task`;
  const access =
    value.modelAccess === "managed"
      ? "model calls run on SelfBench's OpenRouter account"
      : "model calls run on your stored credential";
  const sandbox =
    value.sandbox === "managed"
      ? "sandboxes run on SelfBench's own E2B account"
      : `sandboxes run on your stored ${generationSandboxLabels[value.sandbox]} credential`;
  return `${models} at ${value.reasoning} reasoning. ${access.charAt(0).toUpperCase()}${access.slice(1)} and ${sandbox}. Usage is metered per run.`;
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
      (value.sandbox === "e2b" || value.sandbox === "vercel") &&
      !options.credentials.some(
        (item) =>
          item.id === value.harborCredentialId &&
          item.kind === value.harborEnvironment &&
          item.auth === "api-key",
      )
    )
      return "Choose a Harbor verification credential.";
  }
  return undefined;
}
