import { FileText, Package, Plus, Trash2 } from "lucide-react";
import { type ReactNode, useId } from "react";
import { cn } from "../primitives/cn";
import { InfoTooltip } from "../primitives/tooltip";
import { Button, controlStyles, Input, Select } from "../ui";
import type { EnvironmentInput } from "./environment-api";

type PackageRow = EnvironmentInput["packages"][number];
type FileRow = EnvironmentInput["files"][number];

const update = <T,>(rows: T[], index: number, patch: Partial<T>) =>
  rows.map((row, at) => (at === index ? { ...row, ...patch } : row));

/**
 * An environment's changes to every task: packages installed over the task's own, in a workspace
 * under /app, and files written into or removed from /app before the agent starts. Each change is
 * a card with its own labeled fields, so a filled-in row still says what each value is.
 */
export function EnvironmentChanges({
  packages,
  files,
  onPackagesChange,
  onFilesChange,
  disabled,
}: {
  packages: PackageRow[];
  files: FileRow[];
  onPackagesChange: (rows: PackageRow[]) => void;
  onFilesChange: (rows: FileRow[]) => void;
  disabled: boolean;
}) {
  const empty = packages.length + files.length === 0;
  return (
    <section className="grid gap-3" aria-labelledby="environment-changes">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <h3 id="environment-changes" className="text-sm font-semibold">
            Changes
          </h3>
          <InfoTooltip label="What this environment changes in every task. Each task's instruction, hidden tests, and reference solution stay the same." />
        </div>
        <div className="flex gap-2">
          <Button
            size="small"
            disabled={disabled}
            onClick={() => onPackagesChange([...packages, { name: "", spec: "", directory: "" }])}
          >
            <Plus aria-hidden="true" />
            Add Package
          </Button>
          <Button
            size="small"
            disabled={disabled}
            onClick={() => onFilesChange([...files, { path: "", mode: "append", content: "" }])}
          >
            <Plus aria-hidden="true" />
            Add File
          </Button>
        </div>
      </div>
      {empty ? (
        <p className="border border-dashed border-border px-4 py-8 text-center text-sm leading-6 text-muted-foreground">
          No changes yet. Swap a package for another build, or add, change, or remove a file such as
          AGENTS.md.
        </p>
      ) : (
        <ul className="grid gap-3">
          {packages.map((row, index) => (
            <ChangeCard
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity besides their place
              key={`package-${index}`}
              icon={<Package aria-hidden="true" />}
              title="Swap Package"
              help="Replaces a package the task already installs with another version or build, such as a tarball URL, using the repository's package manager. Directory is the folder under /app that holds its package.json."
              removeLabel="Remove Package"
              disabled={disabled}
              onRemove={() => onPackagesChange(packages.filter((_, at) => at !== index))}
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Package">
                  {(id) => (
                    <Input
                      id={id}
                      placeholder="next"
                      className="font-mono"
                      autoComplete="off"
                      value={row.name}
                      disabled={disabled}
                      onChange={(event) =>
                        onPackagesChange(update(packages, index, { name: event.target.value }))
                      }
                    />
                  )}
                </Field>
                <Field label="Directory">
                  {(id) => (
                    <Input
                      id={id}
                      placeholder="Repository root"
                      className="font-mono placeholder:font-sans"
                      autoComplete="off"
                      value={row.directory}
                      disabled={disabled}
                      onChange={(event) =>
                        onPackagesChange(update(packages, index, { directory: event.target.value }))
                      }
                    />
                  )}
                </Field>
                <Field label="Version or URL" className="sm:col-span-2">
                  {(id) => (
                    <Input
                      id={id}
                      placeholder="15.5.0, a tag, or a tarball URL"
                      className="font-mono placeholder:font-sans"
                      autoComplete="off"
                      value={row.spec}
                      disabled={disabled}
                      onChange={(event) =>
                        onPackagesChange(update(packages, index, { spec: event.target.value }))
                      }
                    />
                  )}
                </Field>
              </div>
            </ChangeCard>
          ))}
          {files.map((row, index) => (
            <ChangeCard
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity besides their place
              key={`file-${index}`}
              icon={<FileText aria-hidden="true" />}
              title="Change File"
              help="Changed in /app before the agent starts, so the agent sees it as part of its files. Append adds to the end of a file that exists, such as AGENTS.md; Replace overwrites it; Delete removes it."
              removeLabel="Remove File"
              disabled={disabled}
              onRemove={() => onFilesChange(files.filter((_, at) => at !== index))}
            >
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem]">
                <Field label="Path">
                  {(id) => (
                    <Input
                      id={id}
                      placeholder="AGENTS.md"
                      className="font-mono"
                      autoComplete="off"
                      value={row.path}
                      disabled={disabled}
                      onChange={(event) =>
                        onFilesChange(update(files, index, { path: event.target.value }))
                      }
                    />
                  )}
                </Field>
                <Field label="Mode">
                  {(id) => (
                    <Select
                      id={id}
                      value={row.mode}
                      disabled={disabled}
                      onChange={(event) =>
                        onFilesChange(
                          update(files, index, { mode: event.target.value as FileRow["mode"] }),
                        )
                      }
                    >
                      <option value="append">Append</option>
                      <option value="replace">Replace</option>
                      <option value="delete">Delete</option>
                    </Select>
                  )}
                </Field>
                {row.mode !== "delete" && (
                  <Field label="Content" className="sm:col-span-2">
                    {(id) => (
                      <textarea
                        id={id}
                        rows={6}
                        placeholder={
                          row.mode === "append"
                            ? "Text to add to the end of the file"
                            : "The file's full contents"
                        }
                        className={cn(
                          controlStyles,
                          "h-auto resize-y py-2 font-mono leading-6 placeholder:font-sans",
                        )}
                        value={row.content}
                        disabled={disabled}
                        onChange={(event) =>
                          onFilesChange(update(files, index, { content: event.target.value }))
                        }
                      />
                    )}
                  </Field>
                )}
              </div>
            </ChangeCard>
          ))}
        </ul>
      )}
    </section>
  );
}

/** One change: a titled card whose header carries its explanation and its remove button. */
function ChangeCard({
  icon,
  title,
  help,
  removeLabel,
  disabled,
  onRemove,
  children,
}: {
  icon: ReactNode;
  title: string;
  help: string;
  removeLabel: string;
  disabled: boolean;
  onRemove: () => void;
  children: ReactNode;
}) {
  return (
    <li className="border border-border">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-card py-1 pr-1 pl-3">
        <span className="flex items-center gap-2 text-sm font-medium [&>svg]:size-4 [&>svg]:text-muted-foreground">
          {icon}
          {title}
          <InfoTooltip label={help} />
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label={removeLabel}
          disabled={disabled}
          onClick={onRemove}
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </div>
      <div className="p-3">{children}</div>
    </li>
  );
}

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className={cn("grid min-w-0 gap-1.5 text-sm font-medium", className)}>
      <label htmlFor={id} className="text-muted-foreground">
        {label}
      </label>
      {children(id)}
    </div>
  );
}
