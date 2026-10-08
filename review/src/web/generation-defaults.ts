import type { CredentialInfo } from "../../../src/db/credentials";
import type { CatalogModel } from "../../../src/evaluation/catalog";
import { generationCredentialRuns, managedRuns } from "../../../src/generation/settings/models";
import {
  type GenerationSettings,
  generationSandboxLabels,
  generationSettingsSchema,
} from "../../../src/generation/settings/settings";
import type { GenerationOptions } from "./GenerationFields";

export const defaultGenerationSettings: GenerationSettings = {
  authorModel: "gpt-6.1-sol",
  verifierModel: "gpt-6.1-sol",
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

/** The run's author and verifier models among those offered; undefined where one is not. */
export function chosenModels(
  value: GenerationSettings,
  models: readonly CatalogModel[],
): (CatalogModel | undefined)[] {
  return [value.authorModel, value.verifierModel].map((id) =>
    models.find((model) => model.id === id),
  );
}

/** Whether one stored credential can run both of the run's models. */
export function modelCredentialMatches(
  credential: Pick<CredentialInfo, "kind" | "auth">,
  models: readonly (CatalogModel | undefined)[],
): boolean {
  return models.every((model) => !!model && generationCredentialRuns(model, credential));
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
  const models = chosenModels(next, options.models);
  // A stored credential that cannot run the chosen models gives way to one that can.
  const current = options.credentials.find((item) => item.id === next.modelCredentialId);
  if (current && !modelCredentialMatches(current, models))
    next = { ...next, modelCredentialId: undefined };
  if (next.modelAccess === "credential" && !next.modelCredentialId) {
    const compatible = options.credentials.filter((item) => modelCredentialMatches(item, models));
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
export function generationSettingsSummary(
  value: GenerationSettings,
  models: readonly CatalogModel[],
): string {
  const [author, verifier] = chosenModels(value, models).map(
    (model, index) => model?.label ?? (index ? value.verifierModel : value.authorModel),
  );
  const model = author === verifier ? author : `${author} / ${verifier}`;
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
  const models = chosenModels(value, options.models);
  if (!models[0]) return "Choose an author model.";
  if (!models[1]) return "Choose a verifier model.";
  if (value.modelAccess === "managed") {
    if (options.managed?.models !== true) return "Choose a model credential.";
    if (!models.every((model) => model && managedRuns(model)))
      return "Choose models that managed access offers.";
  } else if (
    !options.credentials.some(
      (item) => item.id === value.modelCredentialId && modelCredentialMatches(item, models),
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
