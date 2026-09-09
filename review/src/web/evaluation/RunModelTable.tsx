import type { CredentialInfo } from "../../../../src/evaluation/account";
import type { CatalogModel } from "../../../../src/evaluation/catalog";
import type { ComparisonDraft } from "../../../../src/evaluation/comparisons";
import { routeFor } from "../../../../src/evaluation/model-options";
import { DataTable } from "../ui";
import { RunModelRow } from "./RunModelRow";

export function RunModelTable({
  models,
  credentials,
  draft,
  onChange,
}: {
  models: CatalogModel[];
  credentials: CredentialInfo[];
  draft: ComparisonDraft;
  onChange(value: ComparisonDraft): void;
}) {
  const update = (selection: ComparisonDraft["models"][number]) => {
    const others = draft.models.filter((model) => model.catalogId !== selection.catalogId);
    onChange({ ...draft, models: [...others, selection] });
  };

  return (
    <div className="min-w-0">
      <DataTable className="min-w-[850px]">
        <thead>
          <tr>
            <th>Model</th>
            <th>Pricing</th>
            <th>Credential / Route</th>
            <th>Thinking</th>
            <th>Harnesses</th>
          </tr>
        </thead>
        <tbody>
          {models.map((model) => (
            <RunModelRow
              key={model.id}
              model={model}
              credentials={credentials.filter((credential) => routeFor(model, credential.kind))}
              selection={draft.models.find((selection) => selection.catalogId === model.id)}
              onChange={update}
            />
          ))}
        </tbody>
      </DataTable>
      {!models.length && <p className="px-4 py-7 text-base text-muted">No matching models.</p>}
    </div>
  );
}
