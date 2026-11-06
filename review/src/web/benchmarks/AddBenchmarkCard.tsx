import React from "react";
import { REGISTRY_REFERENCE, registryReference } from "../../../../src/contracts/harbor-registry";
import { cn } from "../primitives/cn";
import { InfoTooltip } from "../primitives/tooltip";
import { AddScopeButton } from "../ScopeCard";
import { Button, Input } from "../ui";
import type { RegistryDataset } from "./api";
import { datasetBlock, searchRegistry } from "./registry-search";

/** Why `value` can't be added beside the `added` datasets (`org/name`), or nothing when it can. */
export function benchmarkRefusal(value: string, added: readonly string[]): string | undefined {
  if (!REGISTRY_REFERENCE.test(value)) return "Enter a dataset such as org/name or org/name@ref.";
  const name = registryReference(value).replace(/@[^@]*$/, "");
  if (added.includes(name)) return `${name} is already added.`;
  return undefined;
}

/** Long enough for a tapped result's click to arrive after the input loses focus. */
const BLUR_CLOSE_MS = 150;

type Registry =
  | { status: "loading" }
  | { status: "ok"; datasets: RegistryDataset[] }
  | { status: "failed" };

/**
 * The box that adds a Harbor registry dataset. Typing searches Harbor's registry as you type, and
 * picking a result fills the box; anything else of the form org/name@ref can still be entered.
 * Adding only starts it: the dataset's own box then shows a worker downloading and checking each
 * task.
 */
export function AddBenchmarkCard({
  added,
  onAdd,
  loadRegistry,
}: {
  added: readonly string[];
  onAdd(reference: string): Promise<void>;
  /** Harbor registry's datasets; without it, the box takes typed references only. */
  loadRegistry?: () => Promise<RegistryDataset[]>;
}) {
  const [open, setOpen] = React.useState(false);
  const [value, setValue] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [registry, setRegistry] = React.useState<Registry>({ status: "loading" });
  const [listOpen, setListOpen] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const listId = React.useId();
  const list = React.useRef<HTMLDivElement>(null);
  // Leaving the box closes the list a moment later, not at once: on iOS the input loses focus
  // before a tapped result's click arrives, and closing at once would remove the result first.
  const closing = React.useRef<number>(undefined);
  React.useEffect(() => () => window.clearTimeout(closing.current), []);

  React.useEffect(() => {
    if (!open || !loadRegistry) return;
    let live = true;
    loadRegistry().then(
      (datasets) => live && setRegistry({ status: "ok", datasets }),
      () => live && setRegistry({ status: "failed" }),
    );
    return () => {
      live = false;
    };
  }, [open, loadRegistry]);

  const shown = registry.status === "ok" ? searchRegistry(registry.datasets, value) : [];
  const showList = listOpen && !!loadRegistry && !busy;

  // Keeps the highlighted result in view as the arrow keys move it.
  React.useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return <AddScopeButton label="Add a Dataset" onClick={() => setOpen(true)} />;

  const add = async () => {
    const reference = value.trim();
    const refusal = benchmarkRefusal(reference, added);
    if (refusal) {
      setError(refusal);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onAdd(reference);
      setValue("");
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Dataset could not be added");
    } finally {
      setBusy(false);
    }
  };
  const choose = (dataset: RegistryDataset | undefined) => {
    if (!dataset || datasetBlock(dataset, added)) return;
    setValue(dataset.name);
    setError("");
    setListOpen(false);
  };
  const cancel = () => {
    setOpen(false);
    setValue("");
    setError("");
    setListOpen(false);
  };
  return (
    <form
      className="relative flex h-full min-h-40 flex-col gap-3 border-[1.5px] border-dashed border-foreground/35 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void add();
      }}
    >
      <div className="relative">
        <label className="grid gap-2 text-sm font-semibold" htmlFor="benchmark-reference">
          <span className="flex items-center gap-1.5">
            Harbor Registry Dataset
            <InfoTooltip label="Search Harbor's registry by name or description, or enter org/name@ref. Without @ref, each run uses the latest version." />
          </span>
          <Input
            aria-label="Harbor Registry Dataset"
            id="benchmark-reference"
            type="search"
            placeholder="Search Harbor's Registry"
            role={loadRegistry ? "combobox" : undefined}
            aria-autocomplete={loadRegistry ? "list" : undefined}
            aria-controls={loadRegistry ? listId : undefined}
            aria-expanded={loadRegistry ? showList : undefined}
            aria-activedescendant={showList && shown[active] ? `${listId}-${active}` : undefined}
            enterKeyHint="search"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            className="font-mono"
            value={value}
            disabled={busy}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "benchmark-error" : busy ? "benchmark-help" : undefined}
            onFocus={() => {
              window.clearTimeout(closing.current);
              setListOpen(true);
            }}
            onBlur={() => {
              closing.current = window.setTimeout(() => setListOpen(false), BLUR_CLOSE_MS);
            }}
            onChange={(event) => {
              setValue(event.target.value);
              setError("");
              setActive(0);
              setListOpen(true);
            }}
            onKeyDown={(event) => {
              // Escape closes the list first; with it closed, the search field clears as usual.
              if (event.key === "Escape") {
                if (!showList) return;
                setListOpen(false);
                event.preventDefault();
                return;
              }
              const step = ({ ArrowDown: 1, ArrowUp: -1 } as Record<string, number>)[event.key];
              if (step) {
                setListOpen(true);
                // Never below the first result, even with none yet: once the registry loads,
                // the first result is highlighted and Enter picks it.
                setActive((index) => Math.max(Math.min(index + step, shown.length - 1), 0));
                event.preventDefault();
              } else if (event.key === "Enter" && showList && shown[active]) {
                // Enter picks the highlighted result; with the list closed, it adds what is typed.
                choose(shown[active]);
                event.preventDefault();
              }
            }}
          />
        </label>
        {showList && (
          <div
            ref={list}
            id={listId}
            role="listbox"
            aria-label="Harbor Registry Datasets"
            className="panel absolute inset-x-0 top-full z-30 mt-1 max-h-72 overflow-y-auto bg-background p-1"
          >
            {registry.status === "loading" && (
              <p className="px-3 py-2 text-sm text-muted-foreground">Loading Harbor's registry…</p>
            )}
            {registry.status === "failed" && (
              <p className="px-3 py-2 text-sm text-muted-foreground">
                Harbor's registry could not be listed. Enter org/name to add a dataset.
              </p>
            )}
            {registry.status === "ok" && shown.length === 0 && (
              <p className="px-3 py-2 text-sm text-muted-foreground">
                No datasets match. Enter org/name@ref to add one by name.
              </p>
            )}
            {shown.map((dataset, index) => {
              const block = datasetBlock(dataset, added);
              return (
                <button
                  type="button"
                  key={dataset.name}
                  id={`${listId}-${index}`}
                  data-index={index}
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === active}
                  aria-disabled={block ? true : undefined}
                  className={cn(
                    "grid w-full cursor-default gap-0.5 px-3 py-2 text-left",
                    index === active && "bg-foreground/[0.06]",
                    block && "opacity-55",
                  )}
                  onPointerEnter={() => setActive(index)}
                  // Keep focus in the box, so the list stays open and typing carries on.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(dataset)}
                >
                  {/* The whole name, wrapped: its end is often what tells two datasets apart. */}
                  <span className="font-mono text-sm wrap-anywhere">{dataset.name}</span>
                  <span className="line-clamp-2 text-xs font-normal text-muted-foreground">
                    {[
                      block ??
                        `${dataset.tasks.toLocaleString()} ${dataset.tasks === 1 ? "task" : "tasks"}`,
                      dataset.description,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      {error ? (
        <p id="benchmark-error" role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : (
        busy && (
          <p id="benchmark-help" className="text-xs text-muted-foreground">
            Starting…
          </p>
        )
      )}
      <div className="mt-auto flex justify-end gap-2">
        <Button type="button" size="small" variant="ghost" disabled={busy} onClick={cancel}>
          Cancel
        </Button>
        <Button type="submit" size="small" variant="primary" disabled={busy || !value.trim()}>
          {busy ? "Adding…" : "Add Dataset"}
        </Button>
      </div>
    </form>
  );
}
