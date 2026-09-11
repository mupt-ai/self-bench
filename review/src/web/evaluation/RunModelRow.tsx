import type { CredentialInfo } from "../../../../src/evaluation/account";
import type { CatalogModel } from "../../../../src/evaluation/catalog";
import type { ComparisonDraft } from "../../../../src/evaluation/comparisons";
import { harnessOptions } from "../../../../src/evaluation/harnesses";
import {
  routeFor,
  thinkingLevels,
  thinkingOptions,
} from "../../../../src/evaluation/model-options";
import { Input, Select } from "../ui";
import type { Harness } from "./api";

const mobileLabel = "sr-only";

type ModelSelection = ComparisonDraft["models"][number];

export function RunModelRow({
  model,
  credentials,
  selection,
  onChange,
}: {
  model: CatalogModel;
  credentials: CredentialInfo[];
  selection?: ModelSelection;
  onChange(value: ModelSelection): void;
}) {
  const selected = selection ?? { catalogId: model.id, credentialId: "", harnesses: [] };
  const credential = credentials.find((entry) => entry.id === selected.credentialId);
  const route = credential ? routeFor(model, credential.kind) : undefined;
  const levels = thinkingOptions(model, selected.harnesses);
  const thinking = selected.thinking ?? (levels.includes("high") ? "high" : "default");
  const selectCredential = (credentialId: string) => {
    const nextCredential = credentials.find((entry) => entry.id === credentialId);
    const nextRoute = nextCredential ? routeFor(model, nextCredential.kind) : undefined;
    const harnesses = selected.harnesses.filter(
      (harness) =>
        nextRoute?.harnesses.includes(harness) &&
        (nextCredential?.auth !== "codex-login" || harness === "codex"),
    );
    const available = nextRoute?.harnesses.filter(
      (harness) => nextCredential?.auth !== "codex-login" || harness === "codex",
    );
    onChange({
      ...selected,
      credentialId,
      harnesses: harnesses.length ? harnesses : (available?.slice(0, 1) ?? []),
    });
  };
  const supportsHarness = (harness: Harness) =>
    (route ?? model).harnesses.includes(harness) &&
    (credential?.auth !== "codex-login" || harness === "codex");

  return (
    <div className="grid items-center gap-2 px-3 py-2 pr-10 grid-cols-2 lg:grid-cols-[minmax(0,1fr)_140px_170px_160px]">
      <div className="min-w-0 self-center">
        <strong className="block truncate text-sm font-medium" title={model.label}>
          {model.label}
        </strong>
        {model.id === "custom" && (
          <Input
            aria-label="Custom Model ID"
            placeholder="Model ID"
            value={selected.customModel ?? ""}
            onChange={(event) => onChange({ ...selected, customModel: event.target.value })}
          />
        )}
      </div>
      <div className="min-w-0">
        <span className={mobileLabel}>Credential</span>
        <Select
          className="h-8! border-transparent! bg-transparent! pl-2! pr-7! text-xs! hover:bg-muted!"
          aria-label={`${model.label} Credential`}
          value={selected.credentialId}
          onChange={(event) => selectCredential(event.target.value)}
        >
          <option value="">Select Credential</option>
          {credentials.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="min-w-0">
        <span className={mobileLabel}>Reasoning</span>
        <Select
          className="h-8! border-transparent! bg-transparent! pl-2! pr-7! text-xs! hover:bg-muted!"
          aria-label={`${model.label} Thinking Level`}
          value={thinking}
          onChange={(event) => {
            const level = thinkingLevels.find((value) => value === event.target.value);
            if (level) onChange({ ...selected, thinking: level });
          }}
        >
          {!levels.includes(thinking) && (
            <option value={thinking} disabled>
              {thinking} — unavailable
            </option>
          )}
          {levels.map((level) => (
            <option key={level} value={level}>
              Thinking:{" "}
              {level === "default"
                ? "Default"
                : level === "xhigh"
                  ? "XHigh"
                  : level[0]?.toUpperCase() + level.slice(1)}
            </option>
          ))}
        </Select>
      </div>
      <div className="min-w-0">
        <span className={mobileLabel}>Harness</span>
        <Select
          className="h-8! border-transparent! bg-transparent! pl-2! pr-7! text-xs! hover:bg-muted!"
          aria-label={`${model.label} Harness`}
          value={selected.harnesses.length > 1 ? "multiple" : (selected.harnesses[0] ?? "")}
          onChange={(event) =>
            onChange({
              ...selected,
              harnesses: [event.target.value as Harness],
              thinking: "default",
            })
          }
        >
          <option value="" disabled>
            Choose Harness
          </option>
          {selected.harnesses.length > 1 && (
            <option value="multiple" disabled>
              {selected.harnesses.join(" + ")}
            </option>
          )}
          {harnessOptions
            .filter((harness) => supportsHarness(harness.id))
            .map((harness) => (
              <option key={harness.id} value={harness.id}>
                {harness.label}
              </option>
            ))}
        </Select>
      </div>
    </div>
  );
}
