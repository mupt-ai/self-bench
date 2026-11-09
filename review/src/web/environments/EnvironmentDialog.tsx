import React from "react";
import { MAX_VARIANT_LABEL_LENGTH } from "../../../../src/contracts/variants";
import { Dialog, DialogFooter, DialogHeader } from "../Dialog";
import { GenerationFields } from "../GenerationFields";
import { GenerationSteps } from "../GenerationSteps";
import { InfoTooltip } from "../primitives/tooltip";
import { Button, fieldStyles, Input, Notice } from "../ui";
import { useGenerationSettings } from "../useGenerationSettings";
import { EnvironmentChanges } from "./EnvironmentChanges";
import { createEnvironment, type EnvironmentInput, type EnvironmentItem } from "./environment-api";

type PackageRow = EnvironmentInput["packages"][number];
type FileRow = EnvironmentInput["files"][number];

/**
 * A new environment: the same changes to every approved task's files, such as a framework build
 * from a pull request, or no AGENTS.md. Each task is built and checked once with the generation
 * settings chosen here, never re-authored, so its instruction and tests stay the task's own.
 */
export function EnvironmentDialog({
  org,
  fullName,
  onClose,
  onCreated,
}: {
  org: string;
  fullName: string;
  onClose: () => void;
  onCreated: (environment: EnvironmentItem) => void;
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
      const environment = await createEnvironment(
        org,
        fullName,
        {
          name: label.trim(),
          packages: packages.map((row) => ({
            name: row.name.trim(),
            spec: row.spec.trim(),
            directory: row.directory.trim(),
          })),
          files: files.map((row) => ({ ...row, path: row.path.trim() })),
        },
        settings,
      );
      onCreated(environment);
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
      aria-labelledby="create-environment-title"
    >
      <section className="flex min-w-0 flex-col" aria-labelledby="create-environment-title">
        <DialogHeader
          title="New Environment"
          titleId="create-environment-title"
          description="Builds every approved task with these changes."
          onClose={onClose}
          closeRef={closeButton}
          busy={busy}
        />
        <GenerationSteps step={step} firstStep="Change Environment" />
        {/* The steps row keeps its own bottom margin, so the body pads only its sides and bottom. */}
        <div className="grid gap-4 px-4 pb-6 sm:px-6">
          {step === 1 ? (
            <div className="grid gap-6">
              <label htmlFor="environment-name" className={fieldStyles}>
                <span className="flex items-center gap-1.5">
                  Name
                  <InfoTooltip label="What this environment changes, as conditions and results will name it." />
                </span>
                <Input
                  id="environment-name"
                  aria-label="Name"
                  autoComplete="off"
                  data-1p-ignore
                  maxLength={MAX_VARIANT_LABEL_LENGTH}
                  placeholder="No AGENTS.md"
                  value={label}
                  disabled={busy}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </label>

              <EnvironmentChanges
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
              {busy ? "Starting…" : step === 1 ? "Continue" : "Build Environment"}
            </Button>
          </div>
        </DialogFooter>
      </section>
    </Dialog>
  );
}
