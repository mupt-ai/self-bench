import { Plus } from "lucide-react";
import type { CredentialInfo } from "../../../../src/db/credentials";
import type { CatalogModel } from "../../../../src/evaluation/catalog";
import type { ComparisonDraft } from "../../../../src/evaluation/comparisons";
import { InfoTooltip } from "../primitives/tooltip";
import { Button } from "../ui";
import { customModel } from "./model-selection";
import { RunModelTable } from "./RunModelTable";

/** The Run page's model and harness rows, up to 12, with the button that adds one. */
export function RunModelsPanel({
  models,
  credentials,
  draft,
  disabled,
  onChange,
}: {
  models: CatalogModel[];
  credentials: CredentialInfo[];
  draft: ComparisonDraft;
  disabled: boolean;
  onChange(value: ComparisonDraft): void;
}) {
  return (
    <fieldset className="panel min-w-0 p-0" disabled={disabled}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">Models and Harnesses</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {draft.models.length} of 12 configurations
          </p>
        </div>
        <InfoTooltip label="Add Model">
          <Button
            type="button"
            size="icon"
            aria-label="Add Model"
            disabled={draft.models.length >= 12 || draft.models.some((model) => !model.catalogId)}
            onClick={() =>
              onChange({
                ...draft,
                models: [...draft.models, { catalogId: "", credentialId: "", harnesses: [] }],
              })
            }
          >
            <Plus className="size-4" aria-hidden="true" />
          </Button>
        </InfoTooltip>
      </div>
      <RunModelTable
        models={[...models, customModel]}
        credentials={credentials}
        draft={draft}
        onChange={onChange}
      />
    </fieldset>
  );
}
