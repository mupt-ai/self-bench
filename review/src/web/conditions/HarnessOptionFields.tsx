import type { ReactNode } from "react";
import {
  type HarborAgentOption,
  type HarnessOptionValue,
  harnessOptionsFor,
  MAX_NATIVE_CONFIG,
  MAX_OPTION_TEXT,
} from "../../../../src/contracts/harness-options";
import type { Harness } from "../../../../src/evaluation/models";
import { cn } from "../primitives/cn";
import { InfoTooltip } from "../primitives/tooltip";
import { controlStyles, fieldStyles, Input, Select } from "../ui";
import { isSystemPromptOption, optionText } from "./condition-draft";
import { TOOL_PICKERS, ToolPicker } from "./ToolPicker";

/** What each harness's native config is, where Harbor's description says only "config". */
const NATIVE_CONFIG: Partial<Record<Harness, string>> = {
  "claude-code":
    "Claude Code's settings.json, as a JSON object: env, permissions, hooks, and more.",
  codex: "Codex's config.toml, written as a JSON object.",
  "muse-code": "Muse Code's settings, as a JSON object.",
};

/** The value a field shows when Harbor's default applies: none set, so the field is left blank. */
const DEFAULT = "";

/**
 * Every Harbor option a harness takes, as a field: a blank field, or "Harbor Default", leaves the
 * option at Harbor's own default, so nothing needs adding or removing. Each field's description and
 * default sit in a tooltip beside its label.
 */
export function HarnessOptionFields({
  harness,
  options,
  idPrefix,
  disabled,
  onSet,
}: {
  harness: Harness;
  /** The values set so far for this harness, by option name. */
  options: Readonly<Record<string, HarnessOptionValue>>;
  idPrefix: string;
  disabled: boolean;
  onSet: (name: string, value: string | undefined) => void;
}) {
  return (
    <fieldset
      disabled={disabled}
      className="grid min-w-0 gap-4 border-0 p-0"
      aria-label="Harness Options"
    >
      {harnessOptionsFor(harness)
        // The system prompt is the Instructions field's other place, not an option of its own.
        .filter((option) => !isSystemPromptOption(harness, option.name))
        .map((option) => (
          <OptionField
            key={option.name}
            id={`${idPrefix}-${option.name}`}
            harness={harness}
            option={option}
            value={optionText(option, options[option.name])}
            onChange={(value) => onSet(option.name, value === DEFAULT ? undefined : value)}
          />
        ))}
    </fieldset>
  );
}

function OptionField({
  id,
  harness,
  option,
  value,
  onChange,
}: {
  id: string;
  harness: Harness;
  option: HarborAgentOption;
  value: string;
  onChange: (value: string) => void;
}) {
  const label = option.label;
  const help = (option.kind === "object" && NATIVE_CONFIG[harness]) || option.description;
  const fallback =
    option.default === undefined ? "" : ` Harbor's default: ${String(option.default)}.`;
  const tip = <InfoTooltip label={`${help}${fallback}`} />;
  const defaultLabel =
    option.default === undefined ? "Harbor Default" : `Harbor Default (${String(option.default)})`;
  let control: ReactNode;
  const tools = TOOL_PICKERS[harness]?.includes(option.name);
  if (tools)
    control = (
      <ToolPicker id={id} label={label} harness={harness} value={value} onChange={onChange} />
    );
  else if (option.kind === "boolean")
    control = (
      <Select
        id={id}
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value={DEFAULT}>{defaultLabel}</option>
        <option value="true">On</option>
        <option value="false">Off</option>
      </Select>
    );
  else if (option.kind === "enum")
    control = (
      <Select
        id={id}
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value={DEFAULT}>{defaultLabel}</option>
        {option.values?.map((entry) => (
          <option key={entry} value={entry}>
            {entry}
          </option>
        ))}
      </Select>
    );
  else if (option.kind === "object")
    control = (
      <textarea
        id={id}
        aria-label={label}
        rows={6}
        maxLength={MAX_NATIVE_CONFIG}
        className={cn(controlStyles, "h-auto resize-y py-2 font-mono")}
        placeholder={'{"env": {"BASH_MAX_TIMEOUT_MS": "600000"}}'}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  else
    control = (
      <Input
        id={id}
        aria-label={label}
        type={option.kind === "string" ? "text" : "number"}
        step={option.kind === "number" ? "any" : "1"}
        maxLength={MAX_OPTION_TEXT}
        placeholder={option.default === undefined ? "Harbor Default" : String(option.default)}
        className={cn(option.name === "version" && "font-mono")}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  return (
    <div className={fieldStyles}>
      <label htmlFor={id} className="flex items-center gap-1.5">
        {label}
        {tip}
      </label>
      {control}
    </div>
  );
}
