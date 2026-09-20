import { ChevronDown } from "lucide-react";
import type { CredentialInfo } from "../../../src/evaluation/account";
import type { GenerationSettings } from "../../../src/site/generation-settings";
import { AdvancedFields } from "./GenerationAdvancedFields";
import {
  defaultGenerationSettings,
  generationSelectionProblem,
  generationSettingsSummary,
} from "./generation-defaults";

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
 * Generation settings as one collapsible: the summary line describes what will run, and
 * every field hides under Advanced Settings. It opens itself while the current selection
 * cannot be submitted yet (for example, when this deployment offers nothing managed).
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
  const problem = options ? generationSelectionProblem(value, options) : undefined;
  const customized = value !== defaultGenerationSettings;
  const fields = <AdvancedFields {...{ value, onChange, options, managed }} />;
  return (
    <fieldset disabled={disabled} className="min-w-0 border-0 p-0">
      <details
        className="group border border-border bg-muted/20"
        {...(problem !== undefined && !customized ? { open: true } : {})}
      >
        <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-4 py-3 [&::-webkit-details-marker]:hidden">
          <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            Advanced Settings
            <ChevronDown
              aria-hidden="true"
              className="size-3.5 text-muted-foreground transition-transform group-open:rotate-180"
            />
          </span>
          <span className="hidden min-w-0 flex-1 truncate text-right text-xs text-muted-foreground group-open:hidden sm:block">
            {options ? generationSettingsSummary(value) : "Loading generation settings…"}
          </span>
        </summary>
        <div className="border-t border-border p-4 sm:p-6">{fields}</div>
      </details>
    </fieldset>
  );
}
