import { ChevronDown } from "lucide-react";
import React from "react";
import type { CredentialInfo } from "../../../src/evaluation/account";
import type { GenerationSettings } from "../../../src/site/generation-settings";
import { AdvancedFields } from "./GenerationAdvancedFields";
import { defaultGenerationSettings, generationSettingsSummary } from "./generation-defaults";

export interface GenerationOptions {
  models: string[];
  sandboxes: string[];
  credentials: CredentialInfo[];
  available: boolean;
  /** Whether this deployment offers managed model access and managed sandboxes. */
  managed?: { models: boolean; sandbox: boolean };
}

function managedAvailable(options: GenerationOptions): boolean {
  return options.managed?.models === true && options.managed?.sandbox === true;
}

/** The whole panel is advanced: it is collapsed while the managed defaults stand. */
export function GenerationFields({
  value,
  onChange,
  options,
  disabled,
}: {
  value: GenerationSettings;
  onChange: (value: GenerationSettings) => void;
  options: GenerationOptions | null;
  disabled: boolean;
}) {
  const managed = options ? managedAvailable(options) : true;
  const [advanced, setAdvanced] = React.useState(!options || value !== defaultGenerationSettings);
  if (options && managed && value.modelAccess === "managed" && value.sandbox === "managed")
    return (
      <fieldset disabled={disabled} className="min-w-0 border-0 p-0">
        <GenerationSummary value={value} advanced={advanced} onToggle={() => setAdvanced(true)} />
        {advanced && <AdvancedFields {...{ value, onChange, options, managed }} />}
      </fieldset>
    );
  return (
    <fieldset disabled={disabled} className="min-w-0 border-0 p-0">
      <AdvancedFields {...{ value, onChange, options, managed }} />
    </fieldset>
  );
}

function GenerationSummary({
  value,
  advanced,
  onToggle,
}: {
  value: GenerationSettings;
  advanced: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border border-border bg-muted/20 px-4 py-3">
      <p className="text-sm text-muted-foreground">{generationSettingsSummary(value)}</p>
      <button
        type="button"
        aria-expanded={advanced}
        onClick={onToggle}
        className="inline-flex items-center gap-1 text-sm text-brand hover:text-brand"
      >
        Advanced Settings
        <ChevronDown aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  );
}
