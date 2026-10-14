import { Plus } from "lucide-react";
import React from "react";
import { REGISTRY_REFERENCE, registryReference } from "../../../../src/contracts/harbor-registry";
import { Button, Input } from "../ui";

/** Suggestions only: anything in Harbor's registry can be added. */
const SUGGESTED = [
  "terminal-bench/terminal-bench-2",
  "swe-bench/swe-bench-verified",
  "aider/aider-polyglot",
  "featurebench/featurebench-lite",
  "hello-world/hello-world",
];

/** Why `value` can't be added beside the `added` datasets (`org/name`), or nothing when it can. */
export function benchmarkRefusal(value: string, added: readonly string[]): string | undefined {
  if (!REGISTRY_REFERENCE.test(value)) return "Enter a dataset such as org/name or org/name@ref.";
  const name = registryReference(value).replace(/@[^@]*$/, "");
  if (added.includes(name)) return `${name} is already added.`;
  return undefined;
}

/**
 * The box that adds a Harbor registry dataset. Adding downloads and checks each task, which takes
 * a few seconds for a large dataset, so the box says so while it waits.
 */
export function AddBenchmarkCard({
  added,
  onAdd,
}: {
  added: readonly string[];
  onAdd(reference: string): Promise<void>;
}) {
  const [open, setOpen] = React.useState(false);
  const [value, setValue] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Add a Dataset"
        className="group flex h-full min-h-40 w-full flex-col items-center justify-center gap-2 border-[1.5px] border-dashed border-foreground/15 text-sm font-semibold text-muted-foreground transition-colors hover:border-foreground/35 hover:bg-foreground/[0.03] hover:text-foreground"
      >
        <Plus className="size-5" aria-hidden="true" />
        Add a Dataset
      </button>
    );
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
  return (
    <form
      className="flex h-full min-h-40 flex-col gap-3 border-[1.5px] border-dashed border-foreground/35 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void add();
      }}
    >
      <label className="grid gap-2 text-sm font-semibold" htmlFor="benchmark-reference">
        Harbor Registry Dataset
        <Input
          id="benchmark-reference"
          placeholder="org/name@ref"
          list="benchmark-suggestions"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          className="font-mono"
          value={value}
          disabled={busy}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "benchmark-error" : "benchmark-help"}
          onChange={(event) => {
            setValue(event.target.value);
            setError("");
          }}
        />
      </label>
      <datalist id="benchmark-suggestions">
        {SUGGESTED.filter((name) => !added.includes(name)).map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      {error ? (
        <p id="benchmark-error" role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : (
        <p id="benchmark-help" className="text-xs text-muted-foreground">
          {busy
            ? "Downloading and checking each task…"
            : "Without @ref, each run uses the latest version."}
        </p>
      )}
      <div className="mt-auto flex justify-end gap-2">
        <Button
          type="button"
          size="small"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setValue("");
            setError("");
          }}
        >
          Cancel
        </Button>
        <Button type="submit" size="small" variant="primary" disabled={busy || !value.trim()}>
          {busy ? "Adding…" : "Add Dataset"}
        </Button>
      </div>
    </form>
  );
}
