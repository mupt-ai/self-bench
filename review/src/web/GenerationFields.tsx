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
  /** Which managed capabilities this deployment offers; they are independent keys. */
  managed?: { models: boolean; sandbox: boolean };
  billing?: { configured: boolean; eligible: boolean };
}

/**
 * Generation settings as one collapsible. The closed row names what will run; every field
 * lives inside. It opens itself while the current selection cannot be submitted yet
 * (for example, when this deployment offers nothing managed).
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
  // Each managed option is gated by its own flag; while options load, both appear offered
  // so the summary stays stable until the deployment's keys are known.
  const managed = options
    ? (options.managed ?? { models: false, sandbox: false })
    : { models: true, sandbox: true };
  const problem = options ? generationSelectionProblem(value, options) : undefined;
  const customized = value !== defaultGenerationSettings;
  const fields = <AdvancedFields {...{ value, onChange, options, managed }} />;
  return (
    <fieldset disabled={disabled} className="min-w-0 border-0 p-0">
      <details className="group" {...(problem !== undefined && !customized ? { open: true } : {})}>
        <summary className="flex cursor-pointer list-none items-start justify-between gap-3 [&::-webkit-details-marker]:hidden">
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-foreground">Generation</span>
            <span className="mt-1 block text-sm leading-6 text-muted-foreground group-open:hidden">
              {options ? generationSettingsSummary(value) : "Loading generation settings…"}
            </span>
          </span>
          <ChevronDown
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
          />
        </summary>
        <div className="mt-4">{fields}</div>
      </details>
    </fieldset>
  );
}
