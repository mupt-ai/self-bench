import { Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  type HarborAgentOption,
  type HarnessOptionValue,
  harnessOptionsFor,
  MAX_NATIVE_CONFIG,
  MAX_OPTION_TEXT,
  OPTION_HARNESSES,
} from "../../../../src/contracts/harness-options";
import { type Harness, harnessLabels } from "../../../../src/evaluation/models";
import { cn } from "../primitives/cn";
import { InfoTooltip } from "../primitives/tooltip";
import { Button, controlStyles, fieldStyles, Input, Select } from "../ui";
import { type OptionsDraft, optionText } from "./condition-draft";

/** What each harness's native config is, where Harbor's description says only "config". */
const NATIVE_CONFIG: Partial<Record<Harness, string>> = {
  "claude-code":
    "Claude Code's settings.json, as a JSON object: env, permissions, hooks, and more.",
  codex: "Codex's config.toml, written as a JSON object.",
  "muse-code": "Muse Code's settings, as a JSON object.",
};

/** A newly added option's first value: the one that changes something, where there is one. */
function firstValue(option: HarborAgentOption): string {
  if (option.kind === "boolean") return String(option.default !== true);
  if (option.kind === "enum")
    return option.values?.find((value) => value !== option.default) ?? option.values?.[0] ?? "";
  return "";
}

/**
 * A condition's harness options: for each harness that has any, the options set so far and a
 * picker for the rest. Values stay typed text until the condition is saved (condition-draft.ts).
 */
export function HarnessOptionsEditor({
  value: options,
  idPrefix,
  onChange,
}: {
  value: OptionsDraft;
  idPrefix: string;
  onChange: (options: OptionsDraft) => void;
}) {
  // A harness shows once it has an option set, or once it is added here to set one.
  const [added, setAdded] = useState<Harness[]>([]);
  const shown = OPTION_HARNESSES.filter((harness) => harness in options || added.includes(harness));
  const hidden = OPTION_HARNESSES.filter((harness) => !shown.includes(harness));
  const set = (harness: Harness, name: string, value: HarnessOptionValue | undefined) => {
    const { [name]: _, ...rest } = options[harness] ?? {};
    const next = value === undefined ? rest : { ...rest, [name]: value };
    const { [harness]: __, ...others } = options;
    onChange(Object.keys(next).length ? { ...others, [harness]: next } : others);
  };
  return (
    <div className={fieldStyles}>
      <div className="flex items-center gap-3">
        <span className="flex flex-1 items-center gap-1.5">
          Harness Options
          <InfoTooltip label="Set options on each harness's agent, such as its system prompt, turn limit, tools, version, or native config. A condition with harness options runs only on the harnesses it sets them for." />
        </span>
        {hidden.length > 0 && (
          <span className="w-44">
            <Select
              aria-label="Add Harness"
              value=""
              onChange={(event) => {
                const harness = hidden.find((entry) => entry === event.target.value);
                if (harness) setAdded([...added, harness]);
              }}
            >
              <option value="">Add Harness</option>
              {hidden.map((harness) => (
                <option key={harness} value={harness}>
                  {harnessLabels[harness]}
                </option>
              ))}
            </Select>
          </span>
        )}
      </div>
      {shown.map((harness) => {
        const all = harnessOptionsFor(harness);
        const chosen = options[harness] ?? {};
        const unset = all.filter((option) => !(option.name in chosen));
        return (
          <div key={harness} className="grid gap-3 border border-border p-3">
            <div className="flex items-center gap-3">
              <span className="flex-1 font-semibold">{harnessLabels[harness]}</span>
              {unset.length > 0 && (
                <span className="w-56">
                  <Select
                    aria-label={`Add ${harnessLabels[harness]} Option`}
                    value=""
                    onChange={(event) => {
                      const option = all.find((entry) => entry.name === event.target.value);
                      if (option) set(harness, option.name, firstValue(option));
                    }}
                  >
                    <option value="">Add Option</option>
                    {unset.map((option) => (
                      <option key={option.name} value={option.name}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                </span>
              )}
            </div>
            {all
              .filter((option) => option.name in chosen)
              .map((option) => (
                <OptionField
                  key={option.name}
                  id={`${idPrefix}-${harness}-${option.name}`}
                  harness={harness}
                  option={option}
                  value={optionText(option, chosen[option.name])}
                  onChange={(value) => set(harness, option.name, value)}
                  onRemove={() => set(harness, option.name, undefined)}
                />
              ))}
          </div>
        );
      })}
    </div>
  );
}

function OptionField({
  id,
  harness,
  option,
  value,
  onChange,
  onRemove,
}: {
  id: string;
  harness: Harness;
  option: HarborAgentOption;
  value: string;
  onChange: (value: string) => void;
  onRemove: () => void;
}) {
  const label = `${harnessLabels[harness]} ${option.label}`;
  const help = (option.kind === "object" && NATIVE_CONFIG[harness]) || option.description;
  const fallback = option.default === undefined ? "" : ` Harbor's default: ${option.default}.`;
  const multiline = option.kind === "object" || /prompt/.test(option.name);
  let control: ReactNode;
  if (option.kind === "boolean")
    control = (
      <input
        id={id}
        type="checkbox"
        aria-label={label}
        className="size-4 accent-brand"
        checked={value === "true"}
        onChange={(event) => onChange(String(event.target.checked))}
      />
    );
  else if (option.kind === "enum")
    control = (
      <Select id={id} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        {option.values?.map((entry) => (
          <option key={entry} value={entry}>
            {entry}
          </option>
        ))}
      </Select>
    );
  else if (multiline)
    control = (
      <textarea
        id={id}
        aria-label={label}
        rows={option.kind === "object" ? 6 : 3}
        maxLength={option.kind === "object" ? MAX_NATIVE_CONFIG : MAX_OPTION_TEXT}
        className={cn(
          controlStyles,
          "h-auto resize-y py-2",
          option.kind === "object" && "font-mono",
        )}
        placeholder={option.kind === "object" ? '{"env": {"BASH_MAX_TIMEOUT_MS": "600000"}}' : ""}
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
        className={cn(option.name === "version" && "font-mono")}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="flex flex-1 items-center gap-1.5 font-normal">
          {option.label}
          <InfoTooltip label={`${help}${fallback}`} />
        </label>
        <Button variant="ghost" size="small" aria-label={`Remove ${label}`} onClick={onRemove}>
          <Trash2 aria-hidden="true" />
        </Button>
      </div>
      {control}
    </div>
  );
}
