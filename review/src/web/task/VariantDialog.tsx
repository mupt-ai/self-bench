import React from "react";
import { useNavigate } from "react-router";
import { MAX_VARIANT_LABEL_LENGTH } from "../../../../src/contracts/variants";
import type { TaskItem } from "../api";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "../Dialog";
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

/** Next.js's managed block, as `next dev` writes it, pointing agents at the installed docs. */
const NEXT_DOCS_BLOCK = `
<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in \`node_modules/next/dist/docs/\` (resolved from this file's directory; in monorepos the \`next\` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->
`;

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

  const pointAtNextDocs = () =>
    setFiles((current) => [
      ...current,
      { path: "AGENTS.md", mode: "append", content: NEXT_DOCS_BLOCK },
      { path: "CLAUDE.md", mode: "append", content: NEXT_DOCS_BLOCK },
    ]);

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
        <DialogBody>
          {step === 1 ? (
            <div className="grid gap-5">
              <label htmlFor="variant-label" className={fieldStyles}>
                <span className="flex items-center gap-1.5">
                  Label
                  <InfoTooltip label="Names the change, such as the docs or framework build it tests. The variant keeps this task's instruction, hidden tests, and reference solution; only its environment changes." />
                </span>
                <Input
                  id="variant-label"
                  aria-label="Label"
                  autoComplete="off"
                  data-1p-ignore
                  maxLength={MAX_VARIANT_LABEL_LENGTH}
                  placeholder="Next.js PR 100191 Docs"
                  value={label}
                  disabled={busy}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </label>

              <PackageFields rows={packages} onChange={setPackages} disabled={busy} />
              <FileFields
                rows={files}
                onChange={setFiles}
                disabled={busy}
                onPointAtNextDocs={pointAtNextDocs}
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
        </DialogBody>
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

/** Opens the variant dialog for an accepted task. */
export function CreateVariantButton(props: { org: string; fullName: string; task: TaskItem }) {
  const [open, setOpen] = React.useState(false);
  if (props.task.state !== "accepted") return null;
  return (
    <>
      <Button size="small" onClick={() => setOpen(true)}>
        Create Variant
      </Button>
      {open && <VariantDialog {...props} onClose={() => setOpen(false)} />}
    </>
  );
}
