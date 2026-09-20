import React from "react";
import type { GenerationSettings } from "../../../src/site/generation-settings";
import { fetchGenerationOptions } from "./api";
import type { GenerationOptions } from "./GenerationFields";
import {
  defaultGenerationSettings,
  generationSelectionProblem,
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
    const previous = selection.current.settings;
    if (options && value.sandbox !== previous.sandbox) {
      value = { ...value, sandboxCredentialId: undefined };
      if (value.sandbox !== "e2b" && value.sandbox !== "vercel") {
        value = {
          ...value,
          sandboxImage: undefined,
          harborEnvironment: undefined,
          harborCredentialId: undefined,
        };
      }
    }
    if (
      options &&
      (value.sandbox !== previous.sandbox ||
        value.harborEnvironment !== previous.harborEnvironment ||
        value.modelAccess !== previous.modelAccess)
    )
      value = withDefaultCredentials(value, options);
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
    !!options?.available && !error && generationSelectionProblem(settings, options) === undefined;
  return {
    settings,
    setSettings,
    options,
    error,
    valid,
    reload: () => setRetry((value) => value + 1),
  };
}
