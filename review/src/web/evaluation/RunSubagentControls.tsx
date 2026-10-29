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
  const unsupported = harnesses.filter((harness) => !subagentSupport[harness].configurable);
  if (unsupported.length)
    return (
      <details className="sm:col-span-3 xl:col-span-4">
        <summary className="cursor-pointer text-sm">Subagent Model · Not Supported</summary>
        {unsupported.map((harness) => (
          <p key={harness} className="my-2 text-xs text-muted-foreground">
            {subagentSupport[harness].description}
          </p>
        ))}
      </details>
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
  return (
    <details className="sm:col-span-3 xl:col-span-4">
      <summary className="cursor-pointer text-sm">Subagent Model</summary>
      <p className="my-2 text-xs text-muted-foreground">
        By default, subagents use the parent model. An override applies when the harness delegates;
        it does not force delegation. Subagent calls are included in the run cost.
      </p>
      {harnesses.map((harness) => (
        <p key={harness} className="mb-2 text-xs text-muted-foreground">
          {subagentSupport[harness].description}
        </p>
      ))}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={value !== undefined}
          onChange={(event) =>
            onChange(event.target.checked ? { catalogId: "", credentialId: "" } : undefined)
          }
        />
        Override Subagent Model
      </label>
      {value && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <ModelPicker
            models={available}
            value={value.catalogId}
            onSelect={(next) =>
              onChange({ catalogId: next.id, credentialId: eligible(next)[0]?.id ?? "" })
            }
          />
          <Select
            aria-label="Subagent Credential"
            value={value.credentialId}
            onChange={(event) => onChange({ ...value, credentialId: event.target.value })}
          >
            <option value="" disabled>
              Select Credential
            </option>
            {(model ? eligible(model) : []).map((credential) => (
              <option key={credential.id} value={credential.id}>
                {credential.name}
              </option>
            ))}
          </Select>
        </div>
      )}
    </details>
  );
}
