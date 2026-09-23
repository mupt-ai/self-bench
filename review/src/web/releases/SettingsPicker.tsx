import { Check, Minus } from "lucide-react";
import React from "react";
import { harnessLabels } from "../../../../src/evaluation/models";
import { credentialAccess, providers } from "../evaluation/credential-presentation";
import { thinkingLabel } from "../evaluation/run-presentation";
import { SearchInput } from "../ui";
import type { PreviewSetting } from "./api";

/** The endpoint's host, or the endpoint itself when it does not parse as a URL. */
function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return endpoint;
  }
}

/** The columns that tell two settings of one model apart. */
function columnsOf(setting: PreviewSetting) {
  return {
    harness: harnessLabels[setting.harness],
    reasoning: thinkingLabel(setting.reasoningLevel),
    provider: providers.find((entry) => entry.id === setting.provider)?.label ?? setting.provider,
    host: setting.endpoint ? hostOf(setting.endpoint) : "",
    access: credentialAccess({ kind: setting.provider, auth: setting.signIn }),
  };
}

/** Model, harness, reasoning, provider, access, tasks. */
const grid =
  "grid grid-cols-[minmax(10rem,1.6fr)_minmax(5.5rem,0.9fr)_minmax(5rem,0.8fr)_minmax(7rem,1.2fr)_minmax(7.5rem,0.9fr)_4.5rem] items-center gap-x-3";

/** A square box with a blue check; `mixed` shows a dash for a partly ticked group. */
function Tick({
  id,
  checked,
  mixed = false,
  disabled,
  onChange,
}: {
  id: string;
  checked: boolean;
  mixed?: boolean;
  disabled: boolean;
  onChange(checked: boolean): void;
}) {
  const Mark = mixed ? Minus : Check;
  return (
    <span className="relative inline-flex size-4 shrink-0">
      <input
        type="checkbox"
        id={id}
        aria-checked={mixed ? "mixed" : checked}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="peer size-4 cursor-pointer appearance-none border border-input bg-card transition-colors hover:border-foreground/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-check/40 disabled:cursor-not-allowed disabled:opacity-40"
      />
      <Mark
        aria-hidden="true"
        strokeWidth={3}
        className={`pointer-events-none absolute inset-0 m-auto size-3 text-check ${checked || mixed ? "" : "hidden"}`}
      />
    </span>
  );
}

/** The elbow from a model's checkbox to one of its settings: down, then across. */
function Elbow({ last }: { last: boolean }) {
  return (
    <>
      <span
        aria-hidden="true"
        className={`absolute top-0 left-[23px] w-px bg-foreground/20 ${last ? "h-1/2" : "h-full"}`}
      />
      <span
        aria-hidden="true"
        className="absolute top-1/2 left-[23px] h-px w-[15px] bg-foreground/20"
      />
    </>
  );
}

/** Settings as a table grouped by model, filtered by a search over every column. */
export function SettingsPicker({
  settings,
  tasks,
  ticked,
  query,
  disabled,
  onQuery,
  onChange,
}: {
  settings: readonly PreviewSetting[];
  /** How many approved tasks there are, for each setting's coverage. */
  tasks: number;
  ticked: ReadonlySet<string>;
  query: string;
  disabled: boolean;
  onQuery(query: string): void;
  onChange(next: Set<string>): void;
}) {
  const idBase = React.useId();
  const wordsOf = (text: string) =>
    text
      .toLowerCase()
      .split(/[\s·()/.-]+/)
      .filter(Boolean);
  const words = wordsOf(query);
  // Each word must start a word of the row, so "pi" finds the Pi harness, not "API Key".
  const visible = settings.filter((setting) => {
    const tokens = wordsOf([setting.label, ...Object.values(columnsOf(setting))].join(" "));
    return words.every((word) => tokens.some((token) => token.startsWith(word)));
  });
  const groups = new Map<string, PreviewSetting[]>();
  for (const setting of visible)
    groups.set(setting.label, [...(groups.get(setting.label) ?? []), setting]);
  const set = (keys: readonly string[], on: boolean) => {
    const next = new Set(ticked);
    for (const key of keys) {
      if (on) next.add(key);
      else next.delete(key);
    }
    onChange(next);
  };

  const row = (setting: PreviewSetting, child: { last: boolean } | undefined) => {
    const id = `${idBase}-${setting.id}`;
    const columns = columnsOf(setting);
    return (
      <label
        key={setting.key}
        htmlFor={id}
        className={`${grid} relative cursor-pointer py-2.5 pr-4 text-sm text-muted-foreground hover:bg-muted/60 pl-4`}
      >
        {child && <Elbow last={child.last} />}
        <span className={`flex min-w-0 items-center gap-3 ${child ? "pl-7" : ""}`}>
          <Tick
            id={id}
            checked={ticked.has(setting.key)}
            disabled={disabled}
            onChange={(on) => set([setting.key], on)}
          />
          {child ? (
            <span className="sr-only">{setting.label}</span>
          ) : (
            <span className="truncate font-medium text-foreground">{setting.label}</span>
          )}
        </span>
        <span className="truncate">{columns.harness}</span>
        <span className="truncate">{columns.reasoning}</span>
        <span className="min-w-0">
          <span className="block truncate">{columns.provider}</span>
          {columns.host && <span className="block truncate text-xs">{columns.host}</span>}
        </span>
        <span className="truncate">{columns.access}</span>
        <span className="text-right">
          {setting.coverage.length} / {tasks}
        </span>
      </label>
    );
  };

  return (
    <div className="space-y-2">
      <SearchInput
        placeholder="Search Settings"
        aria-label="Search Settings"
        value={query}
        onChange={(event) => onQuery(event.target.value)}
      />
      <fieldset className="panel max-h-[50dvh] min-w-0 overflow-auto font-mono">
        <legend className="sr-only">Settings to Release</legend>
        {/* Shrinks with the dialog down to this width, then scrolls sideways; rows span it all. */}
        <div className="min-w-[47rem]">
          <div
            className={`${grid} sticky top-0 z-10 border-b border-border bg-card py-2 pr-4 pl-4 text-xs text-muted-foreground`}
            aria-hidden="true"
          >
            <span className="pl-7">Model</span>
            <span>Harness</span>
            <span>Reasoning</span>
            <span>Provider</span>
            <span>Access</span>
            <span className="text-right">Tasks</span>
          </div>
          {groups.size === 0 && (
            <p className="px-4 py-3 text-sm text-muted-foreground">No settings match.</p>
          )}
          <div className="divide-y divide-border">
            {[...groups].map(([model, members], group) => {
              // A model with one setting is one row; a model row only groups two or more.
              const [only] = members;
              if (members.length === 1 && only) return row(only, undefined);
              const keys = members.map((setting) => setting.key);
              const count = keys.filter((key) => ticked.has(key)).length;
              const id = `${idBase}-group-${group}`;
              return (
                <div key={model}>
                  <label
                    htmlFor={id}
                    className="relative flex cursor-pointer items-center gap-3 px-4 py-2.5 text-sm hover:bg-muted/60"
                  >
                    <span
                      aria-hidden="true"
                      className="absolute top-[calc(50%+8px)] bottom-0 left-[23px] w-px bg-foreground/20"
                    />
                    <Tick
                      id={id}
                      checked={count === keys.length}
                      mixed={count > 0 && count < keys.length}
                      disabled={disabled}
                      onChange={() => set(keys, count < keys.length)}
                    />
                    <span className="min-w-0 truncate font-medium text-foreground">{model}</span>
                  </label>
                  {members.map((setting, index) =>
                    row(setting, { last: index === members.length - 1 }),
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </fieldset>
    </div>
  );
}
