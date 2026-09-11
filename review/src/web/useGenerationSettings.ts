import React from "react";
import {
  type GenerationSettings,
  generationSettingsSchema,
} from "../../../src/site/generation-settings";
import { fetchGenerationOptions } from "./api";
import type { GenerationOptions } from "./GenerationFields";
import {
  defaultGenerationSettings,
  readGenerationSettings,
  rememberGenerationSettings,
  withDefaultCredentials,
} from "./generation-defaults";

export function useGenerationSettings(org: string, fullName: string, enabled = true) {
  const key = `selfbench-generation:${org}:${fullName}`;
  const [settings, updateSettings] = React.useState<GenerationSettings>(
    () => readGenerationSettings(key) ?? defaultGenerationSettings,
  );
  const selection = React.useRef({ key, settings });
  const setSettings = (value: GenerationSettings) => {
    if (value.sandbox !== selection.current.settings.sandbox && options) {
      if (value.sandbox !== "docker") {
        value = withDefaultCredentials({ ...value, sandboxCredentialId: undefined }, options);
      }
      if (value.sandbox !== "e2b" && value.sandbox !== "vercel") {
        value = {
          ...value,
          sandboxImage: undefined,
          harborEnvironment: undefined,
          harborCredentialId: undefined,
        };
      }
    }
    selection.current = { key, settings: value };
    updateSettings(value);
    rememberGenerationSettings(key, value);
  };
  const [options, setOptions] = React.useState<GenerationOptions | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [retry, setRetry] = React.useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry reloads the same options.
  React.useEffect(() => {
    if (!enabled) return;
    const previous = selection.current;
    const initial =
      readGenerationSettings(key) ??
      (previous.key === key ? previous.settings : defaultGenerationSettings);
    selection.current = { key, settings: initial };
    updateSettings(initial);
    let active = true;
    let request = 0;
    setOptions(null);
    setError(null);
    const refresh = () => {
      const current = ++request;
      void fetchGenerationOptions(org, fullName).then(
        (result) => {
          if (!active || request !== current) return;
          const next = withDefaultCredentials(selection.current.settings, result);
          selection.current = { key, settings: next };
          updateSettings(next);
          rememberGenerationSettings(key, next);
          setOptions(result);
          setError(null);
        },
        (cause: Error) => {
          if (!active || request !== current) return;
          setOptions(null);
          setError(cause.message);
        },
      );
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
    };
  }, [org, fullName, enabled, retry, key]);
  const valid =
    !!options?.available &&
    !error &&
    generationSettingsSchema.safeParse(settings).success &&
    options.models.includes(settings.authorModel) &&
    options.models.includes(settings.verifierModel) &&
    options.sandboxes.includes(settings.sandbox) &&
    options.credentials.some(
      (item) =>
        item.id === settings.modelCredentialId &&
        item.kind === "openai" &&
        ["api-key", "codex-login"].includes(item.auth),
    ) &&
    (settings.sandbox === "docker" ||
      options.credentials.some(
        (item) =>
          item.id === settings.sandboxCredentialId &&
          item.kind === settings.sandbox &&
          item.auth === "api-key",
      )) &&
    (!(settings.sandbox === "e2b" || settings.sandbox === "vercel") ||
      settings.harborEnvironment !== "modal" ||
      options.credentials.some(
        (item) =>
          item.id === settings.harborCredentialId &&
          item.kind === "modal" &&
          item.auth === "api-key",
      ));
  return {
    settings,
    setSettings,
    options,
    error,
    valid,
    reload: () => setRetry((value) => value + 1),
  };
}
