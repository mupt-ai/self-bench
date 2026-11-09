import { CopyPlus } from "lucide-react";
import React from "react";
import { MAX_VARIANT_LABEL_LENGTH } from "../../../../src/contracts/variants";
import type { TaskItem } from "../api";
import { Dialog, DialogFooter, DialogHeader } from "../Dialog";
import { GenerationFields } from "../GenerationFields";
import { GenerationSteps } from "../GenerationSteps";
import { InfoTooltip } from "../primitives/tooltip";
import { Button, fieldStyles, Input, Notice } from "../ui";
import { useGenerationSettings } from "../useGenerationSettings";
import { createTaskVariant, type VariantInput, type VariantItem } from "./task-variant-api";
import { VariantChanges } from "./VariantFields";

type PackageRow = VariantInput["packages"][number];
type FileRow = VariantInput["files"][number];

/**
 * A variant of an accepted task: the same instruction, hidden tests, and reference solution, with
 * only its environment changed, such as a framework build from a pull request or an AGENTS.md
 * that points agents at docs. It is checked once and accepted if it passes, never re-authored, and
 * listed under the task, whose results it is compared with; it is never a task of its own.
 */
function VariantDialog({
  org,
  fullName,
  task,
  onClose,
  onCreated,
}: {
  org: string;
  fullName: string;
  task: TaskItem;
  onClose: () => void;
  onCreated: (variant: VariantItem) => void;
}) {
  const [step, setStep] = React.useState<1 | 2>(1);
  const {
    settings,
    setSettings,
    options,
    error: optionsError,
    valid,
    reload,
  } = useGenerationSettings(org, fullName);
  const [label, setLabel] = React.useState("");
  const [packages, setPackages] = React.useState<PackageRow[]>([]);
  const [files, setFiles] = React.useState<FileRow[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const closeButton = React.useRef<HTMLButtonElement>(null);
  const filled =
    label.trim().length > 0 &&
    packages.every((row) => row.name.trim() && row.spec.trim()) &&
    files.every((row) => row.path.trim()) &&
    packages.length + files.length > 0;

  const submit = async () => {
    if (busy || !filled || !valid) return;
    setBusy(true);
    setError(null);
    try {
      const variant = await createTaskVariant(
        org,
        fullName,
        task,
        {
          label: label.trim(),
          packages: packages.map((row) => ({
            name: row.name.trim(),
            spec: row.spec.trim(),
            directory: row.directory.trim(),
          })),
          files: files.map((row) => ({ ...row, path: row.path.trim() })),
        },
        settings,
      );
      onCreated(variant);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  return (
    <Dialog
      initialFocus={closeButton}
      onDismiss={onClose}
      busy={busy}
      size="large"
      aria-labelledby="create-variant-title"
    >
      <section className="flex min-w-0 flex-col" aria-labelledby="create-variant-title">
        <DialogHeader
          title="Create Variant"
          titleId="create-variant-title"
          description={<span className="font-mono">{task.taskId}</span>}
          onClose={onClose}
          closeRef={closeButton}
          busy={busy}
        />
        <GenerationSteps step={step} firstStep="Change Environment" />
        {/* The steps row keeps its own bottom margin, so the body pads only its sides and bottom. */}
        <div className="grid gap-4 px-4 pb-6 sm:px-6">
          {step === 1 ? (
            <div className="grid gap-6">
              <label htmlFor="variant-label" className={fieldStyles}>
                <span className="flex items-center gap-1.5">
                  Variant Name
                  <InfoTooltip label="A short name for what this variant changes, so it is easy to tell apart from the task and its other variants." />
                </span>
                <Input
                  id="variant-label"
                  aria-label="Variant Name"
                  autoComplete="off"
                  data-1p-ignore
                  maxLength={MAX_VARIANT_LABEL_LENGTH}
                  placeholder="Docs Before PR 100191"
                  value={label}
                  disabled={busy}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </label>

              <VariantChanges
                packages={packages}
                files={files}
                onPackagesChange={setPackages}
                onFilesChange={setFiles}
                disabled={busy}
              />
            </div>
          ) : optionsError ? (
            <Notice>
              {optionsError} <Button onClick={reload}>Try Again</Button>
            </Notice>
          ) : !options ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading generation settings…
            </p>
          ) : (
            <GenerationFields
              value={settings}
              onChange={setSettings}
              options={options}
              disabled={busy}
            />
          )}
          {error && <Notice>{error}</Notice>}
        </div>
        <DialogFooter className="sticky bottom-0 justify-end">
          <div className="flex gap-3">
            {step === 2 && (
              <Button variant="ghost" disabled={busy} onClick={() => setStep(1)}>
                Back
              </Button>
            )}
            <Button
              variant="primary"
              disabled={busy || !filled || (step === 2 && !valid)}
              onClick={() => (step === 1 ? setStep(2) : void submit())}
            >
              {busy ? "Starting…" : step === 1 ? "Continue" : "Create Variant"}
            </Button>
          </div>
        </DialogFooter>
      </section>
    </Dialog>
  );
}

/**
 * Opens the variant dialog for a task that passed its checks, approved or still awaiting review,
 * as the server allows: a variant is compared with it, not reviewed in its place.
 */
export function CreateVariantButton(props: {
  org: string;
  fullName: string;
  task: TaskItem;
  onCreated: (variant: VariantItem) => void;
}) {
  const [open, setOpen] = React.useState(false);
  if (props.task.pipelineStatus !== "accepted" || props.task.state === "rejected") return null;
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)}>
        <CopyPlus aria-hidden="true" />
        Create Variant
      </Button>
      {open && (
        <VariantDialog
          {...props}
          onClose={() => setOpen(false)}
          onCreated={(variant) => {
            setOpen(false);
            props.onCreated(variant);
          }}
        />
      )}
    </>
  );
}
