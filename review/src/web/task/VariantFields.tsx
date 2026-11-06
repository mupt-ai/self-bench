import { Plus, Trash2 } from "lucide-react";
import { cn } from "../primitives/cn";
import { InfoTooltip } from "../primitives/tooltip";
import { Button, controlStyles, Input, Select } from "../ui";
import type { VariantInput } from "./task-variant-api";

type PackageRow = VariantInput["packages"][number];
type FileRow = VariantInput["files"][number];

const update = <T,>(rows: T[], index: number, patch: Partial<T>) =>
  rows.map((row, at) => (at === index ? { ...row, ...patch } : row));

/** A variant's packages: each installed over the task's own, in a workspace under /app. */
export function PackageFields({
  rows,
  onChange,
  disabled,
}: {
  rows: PackageRow[];
  onChange: (rows: PackageRow[]) => void;
  disabled: boolean;
}) {
  return (
    <fieldset className="grid gap-2" aria-label="Packages">
      <legend className="mb-2 flex items-center gap-1.5 text-sm font-medium">
        Packages
        <InfoTooltip label="Installed over the task's own with its package manager (npm, pnpm, Yarn, or Bun, from its lockfile). Use a version, a tag, or a tarball URL, such as a Next.js build from vercel-packages.vercel.app. Directory is the workspace under /app; leave it blank for the root." />
      </legend>
      {rows.map((row, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity besides their place
          key={index}
          className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)_9rem_auto]"
        >
          <Input
            aria-label="Package"
            placeholder="next"
            className="font-mono"
            value={row.name}
            disabled={disabled}
            onChange={(event) => onChange(update(rows, index, { name: event.target.value }))}
          />
          <Input
            aria-label="Version or URL"
            placeholder="Version or Tarball URL"
            className="font-mono"
            value={row.spec}
            disabled={disabled}
            onChange={(event) => onChange(update(rows, index, { spec: event.target.value }))}
          />
          <Input
            aria-label="Directory"
            placeholder="apps/web"
            className="font-mono"
            value={row.directory}
            disabled={disabled}
            onChange={(event) => onChange(update(rows, index, { directory: event.target.value }))}
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label="Remove Package"
            disabled={disabled}
            onClick={() => onChange(rows.filter((_, at) => at !== index))}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </div>
      ))}
      <div>
        <Button
          size="small"
          disabled={disabled}
          onClick={() => onChange([...rows, { name: "", spec: "", directory: "" }])}
        >
          <Plus aria-hidden="true" />
          Add Package
        </Button>
      </div>
    </fieldset>
  );
}

/** A variant's files: each written into /app before the agent starts, appended or replaced. */
export function FileFields({
  rows,
  onChange,
  disabled,
  onPointAtNextDocs,
}: {
  rows: FileRow[];
  onChange: (rows: FileRow[]) => void;
  disabled: boolean;
  onPointAtNextDocs: () => void;
}) {
  return (
    <fieldset className="grid gap-2" aria-label="Files">
      <legend className="mb-2 flex items-center gap-1.5 text-sm font-medium">
        Files
        <InfoTooltip label="Written into /app before the agent starts, so they are part of its starting files and never its diff. Append adds to an existing file, such as the repository's own AGENTS.md." />
      </legend>
      {rows.map((row, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity besides their place
          key={index}
          className="grid gap-2 border border-border p-3"
        >
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_8rem_auto]">
            <Input
              aria-label="Path"
              placeholder="AGENTS.md"
              className="font-mono"
              value={row.path}
              disabled={disabled}
              onChange={(event) => onChange(update(rows, index, { path: event.target.value }))}
            />
            <Select
              aria-label="Mode"
              value={row.mode}
              disabled={disabled}
              onChange={(event) =>
                onChange(update(rows, index, { mode: event.target.value as FileRow["mode"] }))
              }
            >
              <option value="append">Append</option>
              <option value="replace">Replace</option>
            </Select>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Remove File"
              disabled={disabled}
              onClick={() => onChange(rows.filter((_, at) => at !== index))}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </div>
          <textarea
            aria-label="Content"
            rows={6}
            className={cn(controlStyles, "h-auto resize-y py-2 font-mono text-xs")}
            value={row.content}
            disabled={disabled}
            onChange={(event) => onChange(update(rows, index, { content: event.target.value }))}
          />
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button
          size="small"
          disabled={disabled}
          onClick={() => onChange([...rows, { path: "", mode: "append", content: "" }])}
        >
          <Plus aria-hidden="true" />
          Add File
        </Button>
        <Button size="small" variant="ghost" disabled={disabled} onClick={onPointAtNextDocs}>
          Point Agents at Next.js Docs
        </Button>
      </div>
    </fieldset>
  );
}
