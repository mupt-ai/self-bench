import type { CredentialInfo } from "../../../../src/evaluation/account";
import type { CatalogModel } from "../../../../src/evaluation/catalog";
import type { ComparisonDraft } from "../../../../src/evaluation/comparisons";
import {
  routeFor,
  thinkingLevels,
  thinkingOptions,
} from "../../../../src/evaluation/model-options";
import { Input, Select } from "../ui";
import type { Harness } from "./api";

type ModelSelection = ComparisonDraft["models"][number];
const harnessOptions: { id: Harness; label: string }[] = [
  { id: "codex", label: "Codex" },
  { id: "claude-code", label: "Claude Code" },
  { id: "pi", label: "Pi" },
];

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
  const pricing = route?.pricing ?? (!credential ? model.pricing : undefined);
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
    onChange({ ...selected, credentialId, harnesses });
  };
  const toggleHarness = (harness: Harness) => {
    const harnesses = selected.harnesses.includes(harness)
      ? selected.harnesses.filter((entry) => entry !== harness)
      : [...selected.harnesses, harness];
    onChange({ ...selected, harnesses });
  };
  const supportsHarness = (harness: Harness) =>
    (route ?? model).harnesses.includes(harness) &&
    (credential?.auth !== "codex-login" || harness === "codex");

  return (
    <tr>
      <td>
        <strong>{model.label}</strong>
        <small>
          {model.provider} · {model.model}
        </small>
        {model.id === "custom" && (
          <Input
            aria-label="Custom model ID"
            placeholder="Model ID"
            value={selected.customModel ?? ""}
            onChange={(event) => onChange({ ...selected, customModel: event.target.value })}
          />
        )}
      </td>
      <td>
        {pricing ? `$${pricing.input} / $${pricing.output}` : "Usage-based"}
        <small>
          {pricing ? "Input / output per 1M · reference rates" : "Estimated from run records"}
        </small>
      </td>
      <td>
        <Select
          aria-label={`${model.label} credential`}
          value={selected.credentialId}
          onChange={(event) => selectCredential(event.target.value)}
        >
          <option value="">Select credential</option>
          {credentials.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name} · {entry.kind}
            </option>
          ))}
        </Select>
      </td>
      <td>
        <Select
          aria-label={`${model.label} thinking level`}
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
              {level === "default"
                ? "Model default"
                : level === "xhigh"
                  ? "XHigh"
                  : level[0]?.toUpperCase() + level.slice(1)}
            </option>
          ))}
        </Select>
      </td>
      <td>
        <div className="flex gap-1.5 [&_button]:whitespace-nowrap [&_button]:border [&_button]:border-line-strong [&_button]:bg-transparent [&_button]:p-2 [&_button]:text-[11px] [&_button]:text-muted [&_button[aria-pressed=true]]:border-mint [&_button[aria-pressed=true]]:bg-surface [&_button[aria-pressed=true]]:text-mint [&_button:disabled]:opacity-25">
          {harnessOptions.map((harness) => (
            <button
              type="button"
              key={harness.id}
              aria-label={`${model.label} with ${harness.label}`}
              aria-pressed={selected.harnesses.includes(harness.id)}
              disabled={!supportsHarness(harness.id)}
              onClick={() => toggleHarness(harness.id)}
            >
              {harness.label}
            </button>
          ))}
        </div>
      </td>
    </tr>
  );
}
