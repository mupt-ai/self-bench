import { ChevronDown, CornerDownRight } from "lucide-react";
import { useId, useState } from "react";
import type { CredentialInfo } from "../../../../src/db/credentials";
import type { CatalogModel } from "../../../../src/evaluation/catalog";
import { credentialRunsHarness, type Harness, routeFor } from "../../../../src/evaluation/models";
import {
  harnessesTakeSubagent,
  providerServesSubagent,
  providerTakesSubagent,
} from "../../../../src/evaluation/subagents";
import { ModelPicker } from "../ModelPicker";
import { InfoTooltip } from "../primitives/tooltip";
import { Select } from "../ui";

const SUBAGENT_HINT =
  "The model this harness's subagents run on, through SelfBench's gateway. The agent is told to delegate part of each task. Subagents run at their model's default reasoning level (High where it has one), and a trial's cost is the gateway's total for both models.";

export function RunSubagentControls({
  models,
  credentials,
  value,
  harnesses,
  catalogId,
  provider,
  onChange,
}: {
  models: CatalogModel[];
  credentials: CredentialInfo[];
  harnesses: Harness[];
  /** The row's own model, which is what subagents run on when none is chosen. */
  catalogId: string;
  /** The kind of the row's credential, once one is chosen. */
  provider?: string;
  value?: { catalogId: string; credentialId: string };
  onChange(value: { catalogId: string; credentialId: string } | undefined): void;
}) {
  const [editing, setEditing] = useState(false);
  const panelId = useId();
  const refusal = !harnessesTakeSubagent(harnesses)
    ? "Only Claude Code and Codex can run their subagents on another model."
    : provider && !providerTakesSubagent(provider)
      ? "A custom endpoint cannot run beside a subagent model: the gateway prices each call by the model it names."
      : undefined;
  if (refusal)
    return (
      <p className="-mt-1 flex items-center gap-1.5 text-xs leading-4 text-muted-foreground sm:col-span-3 xl:col-span-4">
        <CornerDownRight className="size-3.5 shrink-0" aria-hidden="true" />
        Subagent Model · Not Supported
        <InfoTooltip label={refusal} />
      </p>
    );
  const eligible = (model: CatalogModel) =>
    credentials.filter(
      (credential) =>
        providerServesSubagent(credential.kind) &&
        harnesses.every(
          (harness) =>
            routeFor(model, credential.kind)?.harnesses.includes(harness) &&
            credentialRunsHarness(credential.auth, harness),
        ),
    );
  const available = models.filter(
    (model) => model.id !== "custom" && model.id !== catalogId && eligible(model).length > 0,
  );
  const model = available.find((entry) => entry.id === value?.catalogId);
  const credential = credentials.find((entry) => entry.id === value?.credentialId);
  return (
    <div className="-mt-1 min-w-0 sm:col-span-3 xl:col-span-4">
      <div className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground">
        <CornerDownRight className="size-3 shrink-0" aria-hidden="true" />
        <span className="shrink-0 text-muted-foreground">Subagent Model</span>
        <InfoTooltip label={SUBAGENT_HINT} />
        <span
          className="min-w-0 truncate text-foreground/80"
          title={model?.label ?? value?.catalogId}
        >
          {value ? (model?.label ?? (value.catalogId || "Choose Model")) : "Same as Parent"}
        </span>
        {value && (
          <span className="hidden min-w-0 truncate sm:inline" title={credential?.name}>
            · {credential?.name ?? "Choose Credential"}
          </span>
        )}
        <button
          type="button"
          className="shrink-0 rounded px-1 text-xs leading-4 text-muted-foreground hover:text-foreground"
          aria-label={editing ? "Collapse Subagent Model Settings" : "Configure Subagent Model"}
          aria-expanded={editing}
          aria-controls={panelId}
          onClick={() => {
            if (!value) onChange({ catalogId: "", credentialId: "" });
            setEditing(!editing);
          }}
        >
          <ChevronDown
            className={`size-4 transition-transform ${editing ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        </button>
      </div>
      {editing && value && (
        <div id={panelId} className="mt-2 rounded-md border border-border/60 bg-muted/20 p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="min-w-0">
              <span className="mb-1.5 block text-xs text-muted-foreground">Subagent Model</span>
              <ModelPicker
                models={available}
                value={value.catalogId}
                onSelect={(next) =>
                  onChange({ catalogId: next.id, credentialId: eligible(next)[0]?.id ?? "" })
                }
              />
            </div>
            <label className="min-w-0" htmlFor={`${panelId}-credential`}>
              <span className="mb-1.5 block text-xs text-muted-foreground">
                Subagent Credential
              </span>
              <Select
                id={`${panelId}-credential`}
                aria-label="Subagent Credential"
                value={value.credentialId}
                onChange={(event) => onChange({ ...value, credentialId: event.target.value })}
              >
                <option value="" disabled>
                  Select Credential
                </option>
                {(model ? eligible(model) : []).map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </Select>
            </label>
          </div>
          <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
            <span />
            <button
              type="button"
              className="shrink-0 rounded py-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => {
                onChange(undefined);
                setEditing(false);
              }}
            >
              Use Parent Model
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
