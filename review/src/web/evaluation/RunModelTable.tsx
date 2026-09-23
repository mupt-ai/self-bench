import { X } from "lucide-react";
import { useState } from "react";
import type { CredentialInfo } from "../../../../src/db/credentials";
import type { CatalogModel } from "../../../../src/evaluation/catalog";
import type { ComparisonDraft } from "../../../../src/evaluation/comparisons";
import { Notice } from "../ui";
import { evaluationRequestId } from "./api";
import { hasDuplicateModelSelections } from "./model-selection";
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
  const [rowKeys] = useState(() => new WeakMap<ComparisonDraft["models"][number], string>());
  return (
    <div className="divide-y divide-border">
      {hasDuplicateModelSelections(models, draft.models) && (
        <Notice>
          Duplicate configurations cannot run. Choose a different model, thinking level, or harness.
        </Notice>
      )}
      {draft.models.map((selected, index) => {
        const rowKey = rowKeys.get(selected) ?? evaluationRequestId();
        rowKeys.set(selected, rowKey);
        const model: CatalogModel = models.find((entry) => entry.id === selected.catalogId) ?? {
          id: selected.catalogId,
          label: "Model",
          provider: "custom",
          model: "",
          harnesses: [],
          source: "",
        };
        return (
          <section key={rowKey} className="relative min-w-0">
            <RunModelRow
              model={model}
              models={models}
              credentials={credentials}
              selection={draft.models[index]}
              onChange={(selection) => {
                rowKeys.set(selection, rowKey);
                onChange({
                  ...draft,
                  models: draft.models.map((entry, position) =>
                    position === index ? selection : entry,
                  ),
                });
              }}
            />
            <button
              type="button"
              className="absolute right-0 bottom-3 flex h-9 w-10 items-center justify-center border-0 bg-transparent p-0 text-muted-foreground hover:text-foreground focus-visible:text-foreground"
              aria-label={`Remove ${model.label}`}
              onClick={() => {
                onChange({
                  ...draft,
                  models:
                    draft.models.length === 1
                      ? [{ catalogId: "", credentialId: "", harnesses: [] }]
                      : draft.models.filter((_entry, position) => position !== index),
                });
              }}
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </section>
        );
      })}
    </div>
  );
}
