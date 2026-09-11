import { useRef } from "react";
import type { CredentialInfo } from "../../../../src/evaluation/account";
import type { CatalogModel } from "../../../../src/evaluation/catalog";
import type { ComparisonDraft } from "../../../../src/evaluation/comparisons";
import { Dialog, DialogFooter, DialogHeader } from "../Dialog";
import { Button, SearchInput } from "../ui";
import { nextModelSelection } from "./model-selection";
import { RunModelTable } from "./RunModelTable";

export function RunModelPicker({
  picking,
  visible,
  draft,
  credentials,
  query,
  setQuery,
  setPicking,
  state,
  setState,
}: {
  picking: boolean;
  visible: CatalogModel[];
  draft: ComparisonDraft;
  credentials: CredentialInfo[];
  query: string;
  setQuery(value: string): void;
  setPicking(value: boolean): void;
  state: { draft: ComparisonDraft; submitted: boolean };
  setState(value: { draft: ComparisonDraft; submitted: boolean }): void;
}) {
  const focus = useRef<HTMLInputElement>(null);
  return (
    <>
      {picking && (
        <Dialog
          initialFocus={focus}
          onDismiss={() => setPicking(false)}
          size="wide"
          aria-labelledby="model-picker-title"
        >
          <DialogHeader
            title="Select Models and Harnesses"
            titleId="model-picker-title"
            description="Choose what to evaluate against your dataset."
            onClose={() => setPicking(false)}
          />
          <div className="space-y-5 p-4 sm:p-6">
            <div>
              <SearchInput
                ref={focus}
                placeholder="Search Models…"
                aria-label="Search Models"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <div className="mt-2 max-h-40 overflow-auto border border-border">
                {visible
                  .filter((model) =>
                    `${model.label} ${model.provider} ${model.model}`
                      .toLowerCase()
                      .includes(query.toLowerCase()),
                  )
                  .map((model) => (
                    <button
                      type="button"
                      key={model.id}
                      disabled={
                        draft.models.length >= 12 || !nextModelSelection(model, credentials)
                      }
                      className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-50"
                      onClick={() => {
                        const selection = nextModelSelection(model, credentials);
                        if (!selection) return;
                        setState({
                          ...state,
                          draft: {
                            ...draft,
                            models: [...draft.models, selection],
                          },
                        });
                        setQuery("");
                      }}
                    >
                      <span>{model.label}</span>
                      <span className="text-xs text-muted-foreground">{model.provider}</span>
                    </button>
                  ))}
              </div>
            </div>
            <section className="border-t border-border pt-5">
              <h3 className="mb-3 text-sm font-medium">Your Selections</h3>
              <RunModelTable
                models={draft.models
                  .map((entry) => visible.find((model) => model.id === entry.catalogId))
                  .filter((model): model is CatalogModel => !!model)}
                credentials={credentials}
                draft={draft}
                onChange={(value) => setState({ ...state, draft: value })}
              />
            </section>
          </div>
          <DialogFooter>
            <Button type="button" variant="primary" onClick={() => setPicking(false)}>
              Done
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </>
  );
}
