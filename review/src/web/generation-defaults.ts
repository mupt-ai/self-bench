import {
  type GenerationSettings,
  generationSettingsSchema,
} from "../../../src/site/generation-settings";
import type { GenerationOptions } from "./GenerationFields";

export const defaultGenerationSettings: GenerationSettings = {
  authorModel: "gpt-5.6-sol",
  verifierModel: "gpt-5.6-sol",
  reasoning: "high",
  sandbox: "modal",
  modelCredentialId: "",
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

export function withDefaultCredentials(
  value: GenerationSettings,
  options: GenerationOptions,
): GenerationSettings {
  return {
    ...value,
    modelCredentialId:
      value.modelCredentialId ||
      options.credentials.find((item) => item.kind === "openai" && item.auth === "api-key")?.id ||
      options.credentials.find((item) => item.kind === "openai" && item.auth === "codex-login")
        ?.id ||
      "",
    sandboxCredentialId:
      value.sandboxCredentialId ||
      options.credentials.find((item) => item.kind === value.sandbox && item.auth === "api-key")
        ?.id,
    harborCredentialId: value.harborEnvironment
      ? value.harborCredentialId ||
        options.credentials.find(
          (item) => item.kind === value.harborEnvironment && item.auth === "api-key",
        )?.id
      : undefined,
  };
}
