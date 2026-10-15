import { Check, ChevronDown } from "lucide-react";
import React from "react";
import { cn } from "./primitives/cn";
import { controlStyles, SearchInput } from "./ui";
import { matchesQuery } from "./word-search";

/** What the picker needs of a model. */
interface PickableModel {
  id: string;
  label: string;
}

/** The list's tallest, as max-h-72; less where the window has less room. */
const LIST_HEIGHT = 288;
/** The search box above the list, and the panel's padding. */
const SEARCH_HEIGHT = 56;

/**
 * Where the open list goes: fixed to the window under the trigger, or over it when there is more
 * room above, so a dialog's or a pane's scrolling edge never cuts it off.
 */
function placement(trigger: HTMLElement): { panel: React.CSSProperties; list: number } {
  const box = trigger.getBoundingClientRect();
  const width = Math.max(box.width, 288);
  const left = Math.max(8, Math.min(box.left, window.innerWidth - width - 8));
  const below = window.innerHeight - box.bottom - 12;
  const above = box.top - 12;
  const up = below < LIST_HEIGHT + SEARCH_HEIGHT && above > below;
  const list = Math.max(120, Math.min(LIST_HEIGHT, (up ? above : below) - SEARCH_HEIGHT));
  return {
    panel: up
      ? { left, width, bottom: window.innerHeight - box.top + 4 }
      : { left, width, top: box.bottom + 4 },
    list,
  };
}

/** The models whose name or id has a word starting with each word of `query`, in list order. */
export function matchingModels<Model extends PickableModel>(
  models: Model[],
  query: string,
): Model[] {
  return models.filter((model) => matchesQuery(`${model.label} ${model.id}`, query));
}

/**
 * The one model select, shared by the run page and generation settings, with its search inside
 * the list: the trigger looks like the form's other selects, and opening it focuses a search box
 * above the models.
 */
export function ModelPicker<Model extends PickableModel>({
  models,
  value,
  onSelect,
  id,
  label = "Model",
}: {
  models: Model[];
  value: string;
  onSelect(model: Model): void;
  id?: string;
  label?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);
  const root = React.useRef<HTMLDivElement>(null);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const list = React.useRef<HTMLDivElement>(null);
  const listId = React.useId();
  const [place, setPlace] = React.useState<ReturnType<typeof placement>>();
  const shown = matchingModels(models, query);
  const selected = models.find((model) => model.id === value);

  const close = React.useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);
  const choose = (model: Model | undefined) => {
    if (!model) return;
    close();
    trigger.current?.focus();
    if (model.id !== value) onSelect(model);
  };

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, close]);
  React.useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      if (trigger.current) setPlace(placement(trigger.current));
    };
    position();
    window.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    return () => {
      window.removeEventListener("scroll", position, true);
      window.removeEventListener("resize", position);
    };
  }, [open]);
  React.useEffect(() => {
    if (open)
      list.current
        ?.querySelector(`[data-index="${active}"]`)
        ?.scrollIntoView?.({ block: "nearest" });
  }, [open, active]);

  return (
    <div className="relative min-w-0" ref={root}>
      <button
        type="button"
        ref={trigger}
        id={id}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(controlStyles, "flex items-center justify-between gap-2 text-left text-sm")}
        onClick={() => {
          if (open) close();
          else {
            setActive(
              Math.max(
                0,
                models.findIndex((model) => model.id === value),
              ),
            );
            setOpen(true);
          }
        }}
      >
        <span className={cn("truncate", !selected && "text-muted-foreground")}>
          {selected?.label ?? "Select Model"}
        </span>
        <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <div className="panel fixed z-50 bg-background p-1 font-normal" style={place?.panel}>
          <SearchInput
            autoFocus
            role="combobox"
            aria-label="Search Models"
            aria-controls={listId}
            aria-expanded="true"
            aria-autocomplete="list"
            aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
            placeholder="Search Models"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              const moves: Record<string, number> = { ArrowDown: 1, ArrowUp: -1 };
              const step = moves[event.key];
              if (step) setActive((index) => Math.min(Math.max(index + step, 0), shown.length - 1));
              else if (event.key === "Enter") choose(shown[active]);
              else if (event.key === "Escape") {
                close();
                trigger.current?.focus();
              } else return;
              event.preventDefault();
            }}
          />
          <div
            ref={list}
            id={listId}
            role="listbox"
            tabIndex={-1}
            aria-label="Models"
            className="mt-1 overflow-y-auto"
            style={{ maxHeight: place?.list ?? LIST_HEIGHT }}
          >
            {shown.map((model, index) => (
              <button
                type="button"
                key={model.id}
                id={`${listId}-${index}`}
                data-index={index}
                role="option"
                tabIndex={-1}
                aria-selected={model.id === value}
                className={cn(
                  "flex w-full cursor-default items-center justify-between gap-2 px-3 py-2 text-left text-sm",
                  index === active && "bg-foreground/[0.06]",
                )}
                onPointerEnter={() => setActive(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(model)}
              >
                <span className="truncate">{model.label}</span>
                {model.id === value && <Check aria-hidden="true" className="size-3.5 shrink-0" />}
              </button>
            ))}
            {!shown.length && (
              <p className="px-3 py-2 text-sm text-muted-foreground">No models match.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
