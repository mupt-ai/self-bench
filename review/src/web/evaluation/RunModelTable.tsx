import type { CredentialInfo } from "../../../../src/evaluation/account";
import type { CatalogModel } from "../../../../src/evaluation/catalog";
import type { ComparisonDraft } from "../../../../src/evaluation/comparisons";
import { routeFor } from "../../../../src/evaluation/model-options";
import { Button } from "../ui";
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
  return (
    <div className="space-y-1">
      {models.map((model, index) => (
        <section
          key={`${model.id}-${draft.models[index]?.harnesses.join("+")}`}
          className="relative border border-border bg-card"
        >
          <RunModelRow
            model={model}
            credentials={credentials.filter((credential) => routeFor(model, credential.kind))}
            selection={draft.models[index]}
            onChange={(selection) =>
              onChange({
                ...draft,
                models: draft.models.map((entry, position) =>
                  position === index ? selection : entry,
                ),
              })
            }
          />
          <Button
            type="button"
            size="small"
            className="absolute right-2 top-2 border-transparent! text-muted-foreground hover:text-foreground"
            aria-label={`Remove ${model.label}`}
            onClick={() =>
              onChange({
                ...draft,
                models: draft.models.filter((_entry, position) => position !== index),
              })
            }
          >
            ×
          </Button>
        </section>
      ))}
      {!models.length && (
        <p className="flex min-h-40 items-center justify-center border border-dashed border-border p-6 text-sm text-muted-foreground">
          Add a model to get started.
        </p>
      )}
    </div>
  );
}
