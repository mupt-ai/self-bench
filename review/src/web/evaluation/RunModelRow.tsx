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
import { nextModelSelection } from "./model-selection";

const mobileLabel = "mb-2 block text-xs text-muted-foreground";

type ModelSelection = ComparisonDraft["models"][number];

export function RunModelRow({
  model,
  models = [model],
  credentials,
  selection,
  onChange,
}: {
  model: CatalogModel;
  models?: CatalogModel[];
  credentials: CredentialInfo[];
  selection?: ModelSelection;
  onChange(value: ModelSelection): void;
}) {
  const selected = selection ?? { catalogId: model.id, credentialId: "", harnesses: [] };
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

  return (
    <div className="grid grid-cols-1 items-center gap-3 px-4 py-3 pr-10 sm:grid-cols-3 xl:grid-cols-[minmax(0,1.2fr)_repeat(3,minmax(0,1fr))]">
      <div className="min-w-0 sm:col-span-3 xl:col-span-1">
        <span className={mobileLabel}>Model</span>
        <Select
          className="text-xs md:text-xs"
          aria-label="Model"
          value={selected.catalogId}
          onChange={(event) => {
            const nextModel = models.find((entry) => entry.id === event.target.value);
            if (!nextModel) return;
            const next = nextModelSelection(nextModel, credentials, selected.harnesses[0]) ??
              nextModelSelection(nextModel, credentials) ?? {
                catalogId: nextModel.id,
                credentialId: "",
                harnesses: [],
              };
            if (
              selected.thinking &&
              thinkingOptions(nextModel, next.harnesses).includes(selected.thinking)
            )
              next.thinking = selected.thinking;
            onChange(next);
          }}
        >
          <option value="" disabled>
            Select Model
          </option>
          {models.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </Select>
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
          className="text-xs md:text-xs"
          aria-label={`${model.label} Credential`}
          disabled={!selected.catalogId}
          value={selected.credentialId}
          onChange={(event) => selectCredential(event.target.value)}
        >
          <option value="">Select Credential</option>
          {credentials
            .filter((entry) => routeFor(model, entry.kind))
            .map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
        </Select>
      </div>
      <div className="min-w-0">
        <span className={mobileLabel}>Reasoning</span>
        <Select
          className="text-xs md:text-xs"
          aria-label={`${model.label} Thinking Level`}
          disabled={!selected.catalogId}
          value={thinking}
          onChange={(event) => {
            const level = thinkingLevels.find((value) => value === event.target.value);
            if (level) onChange({ ...selected, thinking: level });
          }}
        >
          {!levels.includes(thinking) && (
            <option value={thinking} disabled>
              Select Thinking Level
            </option>
          )}
          {levels.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </Select>
      </div>
      <div className="min-w-0">
        <span className={mobileLabel}>Harness</span>
        <Select
          className="text-xs md:text-xs"
          aria-label={`${model.label} Harness`}
          disabled={!selected.catalogId}
          value={selected.harnesses.length > 1 ? "multiple" : (selected.harnesses[0] ?? "")}
          onChange={(event) =>
            onChange({
              ...selected,
              harnesses: [event.target.value as Harness],
              thinking: undefined,
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
          {harnessOptions.map((harness) => (
            <option key={harness.id} value={harness.id}>
              {harness.label}
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}
