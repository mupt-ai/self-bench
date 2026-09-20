import { ChevronDown } from "lucide-react";
import React from "react";
import type { CredentialInfo } from "../../../src/evaluation/account";
import type { GenerationSettings } from "../../../src/site/generation-settings";
import { AdvancedFields } from "./GenerationAdvancedFields";
import { defaultGenerationSettings, generationSettingsSummary } from "./generation-defaults";
import { cn } from "./primitives/cn";

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

/**
 * Generation settings. With everything managed, the panel is one summary card; the fields
 * hide behind its Advanced Settings toggle and reopen automatically for custom settings.
 */
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
  const atDefaults =
    options?.available === true &&
    managed &&
    value.modelAccess === "managed" &&
    value.sandbox === "managed";
  const [advanced, setAdvanced] = React.useState(!options || value !== defaultGenerationSettings);
  if (!atDefaults)
    return (
      <fieldset disabled={disabled} className="min-w-0 border-0 p-0">
        <AdvancedFields {...{ value, onChange, options, managed }} />
      </fieldset>
    );
  return (
    <fieldset disabled={disabled} className="min-w-0 border-0 p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 border border-border bg-muted/20 px-4 py-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">Managed Generation</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {generationSettingsSummary(value)}
          </p>
        </div>
        <button
          type="button"
          aria-expanded={advanced}
          onClick={() => setAdvanced((current) => !current)}
          className="inline-flex shrink-0 items-center gap-1 text-sm text-brand hover:text-brand"
        >
          {advanced ? "Hide Advanced Settings" : "Advanced Settings"}
          <ChevronDown
            aria-hidden="true"
            className={cn("size-3.5 transition-transform", advanced && "rotate-180")}
          />
        </button>
      </div>
      {advanced && (
        <div className="mt-6">
          <AdvancedFields {...{ value, onChange, options, managed }} />
        </div>
      )}
    </fieldset>
  );
}
