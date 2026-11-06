import { CopyPlus } from "lucide-react";
import React from "react";
import { useNavigate } from "react-router";
import { MAX_VARIANT_LABEL_LENGTH } from "../../../../src/contracts/variants";
import type { TaskItem } from "../api";
import { Dialog, DialogFooter, DialogHeader } from "../Dialog";
import { GenerationFields } from "../GenerationFields";
import { GenerationSteps } from "../GenerationSteps";
import { InfoTooltip } from "../primitives/tooltip";
import { Button, fieldStyles, Input, Notice } from "../ui";
import { useGenerationSettings } from "../useGenerationSettings";
import { taskPath } from "./review-queue";
import { createTaskVariant, type VariantInput } from "./task-variant-api";
import { FileFields, PackageFields } from "./VariantFields";

type PackageRow = VariantInput["packages"][number];
type FileRow = VariantInput["files"][number];

/**
 * A variant of an accepted task: the same instruction, hidden tests, and reference solution, with
 * only its environment changed, such as a framework build from a pull request or an AGENTS.md
 * that points agents at docs. It is checked once and accepted if it passes, never re-authored, so
 * the two tasks' results can be compared.
 */
function VariantDialog({
  org,
  fullName,
  task,
  onClose,
}: {
  org: string;
  fullName: string;
  task: TaskItem;
  onClose: () => void;
}) {
  const navigate = useNavigate();
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
      navigate(taskPath(fullName, variant));
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
                  <InfoTooltip label="What this variant changes, so it is easy to tell apart in the task list, such as Docs Before PR 100191. The instruction, hidden tests, and reference solution stay the same." />
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

              <PackageFields rows={packages} onChange={setPackages} disabled={busy} />
              <FileFields rows={files} onChange={setFiles} disabled={busy} />
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
export function CreateVariantButton(props: { org: string; fullName: string; task: TaskItem }) {
  const [open, setOpen] = React.useState(false);
  if (props.task.pipelineStatus !== "accepted" || props.task.state === "rejected") return null;
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)}>
        <CopyPlus aria-hidden="true" />
        Create Variant
      </Button>
      {open && <VariantDialog {...props} onClose={() => setOpen(false)} />}
    </>
  );
}
