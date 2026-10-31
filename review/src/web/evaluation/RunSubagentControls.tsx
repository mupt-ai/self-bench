import { CornerDownRight } from "lucide-react";
import { useId, useState } from "react";
import type { CredentialInfo } from "../../../../src/db/credentials";
import type { CatalogModel } from "../../../../src/evaluation/catalog";
import { credentialRunsHarness, type Harness, routeFor } from "../../../../src/evaluation/models";
import { subagentSupport } from "../../../../src/evaluation/subagents";
import { ModelPicker } from "../ModelPicker";
import { Select } from "../ui";

export function RunSubagentControls({
  models,
  credentials,
  value,
  harnesses,
  onChange,
}: {
  models: CatalogModel[];
  credentials: CredentialInfo[];
  harnesses: Harness[];
  value?: { catalogId: string; credentialId: string };
  onChange(value: { catalogId: string; credentialId: string } | undefined): void;
}) {
  const [editing, setEditing] = useState(false);
  const panelId = useId();
  const unsupported = harnesses.filter((harness) => !subagentSupport[harness].configurable);
  if (unsupported.length)
    return (
      <p
        className="flex items-center gap-2 text-xs text-muted-foreground sm:col-span-3 xl:col-span-4"
        title={unsupported.map((harness) => subagentSupport[harness].description).join(" ")}
      >
        <CornerDownRight className="size-3.5 shrink-0" aria-hidden="true" />
        Subagent Model · Not Supported
      </p>
    );
  const eligible = (model: CatalogModel) =>
    credentials.filter((credential) =>
      harnesses.every(
        (harness) =>
          routeFor(model, credential.kind)?.harnesses.includes(harness) &&
          credentialRunsHarness(credential.auth, harness),
      ),
    );
  const available = models.filter((model) => model.id !== "custom" && eligible(model).length > 0);
  const model = available.find((entry) => entry.id === value?.catalogId);
  const credential = credentials.find((entry) => entry.id === value?.credentialId);
  return (
    <div className="min-w-0 sm:col-span-3 xl:col-span-4">
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <CornerDownRight className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="shrink-0">Subagent</span>
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
          className="ml-auto shrink-0 rounded px-1 py-1 text-xs text-muted-foreground hover:text-foreground"
          aria-label={
            editing
              ? "Done Editing Subagent Model"
              : value
                ? "Edit Subagent Model"
                : "Add Subagent Model"
          }
          aria-expanded={editing}
          aria-controls={panelId}
          onClick={() => {
            if (!value) onChange({ catalogId: "", credentialId: "" });
            setEditing(!editing);
          }}
        >
          {editing ? "Done" : value ? "Edit" : "Add Override"}
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
            <p className="max-w-xl text-xs leading-5 text-muted-foreground">
              Applies when the harness delegates; it does not force delegation. Subagent calls are
              included in the run cost.{" "}
              {harnesses.map((harness) => subagentSupport[harness].description).join(" ")}
            </p>
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
