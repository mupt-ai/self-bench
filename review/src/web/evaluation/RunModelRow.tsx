import { thinkingLevels } from "../../../../src/contracts/models";
import type { CredentialInfo } from "../../../../src/db/credentials";
import type { CatalogModel } from "../../../../src/evaluation/catalog";
import type { ComparisonDraft } from "../../../../src/evaluation/comparisons";
import {
  credentialRunsHarness,
  defaultThinking,
  harnessLabels,
  harnessOptions,
  modelHarnesses,
  routeFor,
  thinkingOptions,
} from "../../../../src/evaluation/models";
import type { SavedHarness } from "../harnesses/harness-api";
import { ModelPicker } from "../ModelPicker";
import { Input, Select } from "../ui";
import type { Harness } from "./api";
import { nextModelSelection, pickerValue, savedSelection } from "./model-selection";
import { savedHarnessAgent } from "./run-harnesses";

const mobileLabel = "mb-2 block text-xs font-semibold text-muted-foreground xl:hidden";

type ModelSelection = ComparisonDraft["models"][number];

/** A saved harness's option value in the Harness select, beside the agents' own ids. */
const SAVED_HARNESS = "saved:";

export function RunModelRow({
  model,
  models = [model],
  credentials,
  selection,
  saved,
  onChange,
}: {
  model: CatalogModel;
  models?: CatalogModel[];
  credentials: CredentialInfo[];
  selection?: ModelSelection;
  /** The workspace's saved harnesses, offered beside the agents; none where a page runs none. */
  saved?: SavedHarness[];
  onChange(value: ModelSelection): void;
}) {
  const selected = selection ?? { catalogId: model.id, credentialId: "", harnesses: [] };
  /** `next`, keeping the row's saved harness while it still runs on the same agent. */
  const keepingSaved = (next: ModelSelection): ModelSelection => {
    const { harness, ...rest } = next;
    const same =
      selected.harness !== undefined &&
      next.harnesses.length === 1 &&
      next.harnesses[0] === selected.harnesses[0];
    return same ? { ...rest, harness: selected.harness } : rest;
  };
  const credential = credentials.find((entry) => entry.id === selected.credentialId);
  const route = credential ? routeFor(model, credential.kind) : undefined;
  const levels = thinkingOptions(route ?? model, selected.harnesses);
  const thinking = selected.thinking ?? defaultThinking(levels);
  const selectCredential = (credentialId: string) => {
    const nextCredential = credentials.find((entry) => entry.id === credentialId);
    const nextRoute = nextCredential ? routeFor(model, nextCredential.kind) : undefined;
    const harnesses = selected.harnesses.filter(
      (harness) =>
        nextRoute?.harnesses.includes(harness) &&
        credentialRunsHarness(nextCredential?.auth ?? "api-key", harness),
    );
    const available = nextRoute?.harnesses.filter((harness) =>
      credentialRunsHarness(nextCredential?.auth ?? "api-key", harness),
    );
    const nextHarnesses = harnesses.length ? harnesses : (available?.slice(0, 1) ?? []);
    onChange(keepingSaved({ ...selected, credentialId, harnesses: nextHarnesses }));
  };
  // Until a credential is chosen, every harness some credential runs the model on.
  const supportsHarness = (harness: Harness) =>
    (route?.harnesses ?? modelHarnesses(model)).includes(harness) &&
    credentialRunsHarness(credential?.auth ?? "api-key", harness);

  // Saved harnesses this row can run: each on its own agent, or the row's when it names none.
  const current = selected.harnesses.length === 1 ? selected.harnesses[0] : undefined;
  const offered = (saved ?? []).flatMap((entry) => {
    const agent = savedHarnessAgent(entry, current);
    return agent && supportsHarness(agent) ? [{ saved: entry, agent }] : [];
  });
  // The row's saved harness when it is no longer offered, so the select can show it and change it.
  const own = saved?.find((entry) => entry.id === selected.harness);
  const unlisted =
    selected.harness !== undefined && !offered.some((entry) => entry.saved.id === selected.harness)
      ? own
        ? own.name
        : saved
          ? "Deleted Harness"
          : "Saved Harness"
      : undefined;

  return (
    <div className="grid grid-cols-1 items-center gap-3 px-4 py-3 pr-10 sm:grid-cols-3 xl:grid-cols-[minmax(0,1.2fr)_repeat(3,minmax(0,1fr))]">
      <div className="min-w-0 sm:col-span-3 xl:col-span-1">
        <span className={mobileLabel}>Model</span>
        <ModelPicker
          models={models}
          value={
            models.some((entry) => entry.id === pickerValue(selected))
              ? pickerValue(selected)
              : selected.catalogId
          }
          onSelect={(nextModel) => {
            const custom = savedSelection(nextModel, credentials, selected.harnesses[0]);
            if (custom) return onChange(keepingSaved(custom));
            const next = nextModelSelection(nextModel, credentials, selected.harnesses[0]) ??
              nextModelSelection(nextModel, credentials) ?? {
                catalogId: nextModel.id,
                credentialId: "",
                harnesses: [],
              };
            const nextKind = credentials.find((entry) => entry.id === next.credentialId)?.kind;
            const nextRoute = nextKind ? routeFor(nextModel, nextKind) : undefined;
            if (
              selected.thinking &&
              thinkingOptions(nextRoute ?? nextModel, next.harnesses).includes(selected.thinking)
            )
              next.thinking = selected.thinking;
            onChange(keepingSaved(next));
          }}
        />
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
          className="text-sm md:text-sm"
          aria-label={`${model.label} Credential`}
          disabled={!selected.catalogId}
          value={selected.credentialId}
          onChange={(event) => selectCredential(event.target.value)}
        >
          <option value="" disabled>
            Select Credential
          </option>
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
          className="text-sm md:text-sm"
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
          className="text-sm md:text-sm"
          aria-label={`${model.label} Harness`}
          disabled={!selected.catalogId}
          value={
            selected.harness !== undefined
              ? `${SAVED_HARNESS}${selected.harness}`
              : selected.harnesses.length > 1
                ? "multiple"
                : (selected.harnesses[0] ?? "")
          }
          onChange={(event) => {
            const { value } = event.target;
            const savedId = value.startsWith(SAVED_HARNESS)
              ? Number(value.slice(SAVED_HARNESS.length))
              : undefined;
            const agent =
              savedId === undefined
                ? (value as Harness)
                : offered.find((entry) => entry.saved.id === savedId)?.agent;
            if (!agent) return;
            const { harness: _, ...rest } = selected;
            onChange({
              ...rest,
              harnesses: [agent],
              ...(savedId !== undefined ? { harness: savedId } : {}),
              // A level picked for one agent may not be another's.
              ...(agent === selected.harnesses[0] ? {} : { thinking: undefined }),
            });
          }}
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
          {(offered.length > 0 || unlisted) && (
            <optgroup label="Saved Harnesses">
              {offered.map(({ saved: entry, agent }) => (
                <option key={entry.id} value={`${SAVED_HARNESS}${entry.id}`}>
                  {entry.name} ({harnessLabels[agent]})
                </option>
              ))}
              {unlisted && (
                <option value={`${SAVED_HARNESS}${selected.harness}`} disabled>
                  {unlisted}
                </option>
              )}
            </optgroup>
          )}
        </Select>
      </div>
    </div>
  );
}
