import { X } from "lucide-react";
import { useState } from "react";
import type { CredentialInfo } from "../../../../src/evaluation/account";
import type { CatalogModel } from "../../../../src/evaluation/catalog";
import type { ComparisonDraft } from "../../../../src/evaluation/comparisons";
import { Button, Notice } from "../ui";
import { hasModelSelection } from "./model-selection";
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
  const [error, setError] = useState("");
  return (
    <div className="divide-y divide-border">
      {error && <Notice>{error}</Notice>}
      {draft.models.map((selected, index) => {
        const model: CatalogModel = models.find((entry) => entry.id === selected.catalogId) ?? {
          id: selected.catalogId,
          label: "Model",
          provider: "custom",
          model: "",
          harnesses: [],
          source: "",
        };
        return (
          <section
            key={`${model.id}-${draft.models[index]?.harnesses.join("+")}-${draft.models[index]?.thinking ?? "auto"}`}
            className="relative min-w-0 bg-card"
          >
            <RunModelRow
              model={model}
              models={models}
              credentials={credentials}
              selection={draft.models[index]}
              onChange={(selection) => {
                if (
                  hasModelSelection(
                    models.find((entry) => entry.id === selection.catalogId) ?? model,
                    draft.models.filter((_entry, position) => position !== index),
                    selection,
                  )
                ) {
                  setError("That model, thinking level, and harness are already added.");
                  return;
                }
                setError("");
                onChange({
                  ...draft,
                  models: draft.models.map((entry, position) =>
                    position === index ? selection : entry,
                  ),
                });
              }}
            />
            <Button
              type="button"
              size="small"
              variant="ghost"
              className="absolute right-2 bottom-3 h-9 w-8 px-0 text-muted-foreground hover:text-foreground"
              aria-label={`Remove ${model.label}`}
              onClick={() => {
                setError("");
                onChange({
                  ...draft,
                  models:
                    draft.models.length === 1
                      ? [{ catalogId: "", credentialId: "", harnesses: [] }]
                      : draft.models.filter((_entry, position) => position !== index),
                });
              }}
            >
              <X aria-hidden="true" />
            </Button>
          </section>
        );
      })}
    </div>
  );
}
