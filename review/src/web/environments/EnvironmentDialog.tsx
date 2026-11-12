import React from "react";
import {
  MAX_ENVIRONMENT_SCRIPT_BYTES,
  MAX_VARIANT_LABEL_LENGTH,
} from "../../../../src/contracts/variants";
import { Dialog, DialogFooter, DialogHeader } from "../Dialog";
import { GenerationFields } from "../GenerationFields";
import { GenerationSteps } from "../GenerationSteps";
import { cn } from "../primitives/cn";
import { InfoTooltip } from "../primitives/tooltip";
import { Button, controlStyles, fieldStyles, Input, Notice } from "../ui";
import { useGenerationSettings } from "../useGenerationSettings";
import { createEnvironment, type EnvironmentBuild } from "./environment-api";

/** What the script field shows empty: the two changes environments are most often made for. */
const EXAMPLE_SCRIPT = "rm -f AGENTS.md CLAUDE.md\npnpm add next@15.5.0";

/**
 * A new environment: one script run in every approved task's image, such as removing AGENTS.md or
 * installing a framework build from a pull request. Each task is built and checked once with the
 * generation settings chosen here, never re-authored, so its instruction and tests stay the
 * task's own.
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
  onCreated: (build: EnvironmentBuild) => void;
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
  const [script, setScript] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const closeButton = React.useRef<HTMLButtonElement>(null);
  const tooLong = new Blob([script]).size > MAX_ENVIRONMENT_SCRIPT_BYTES;
  const filled = label.trim().length > 0 && script.trim().length > 0 && !tooLong;

  const submit = async () => {
    if (busy || !filled || !valid) return;
    setBusy(true);
    setError(null);
    try {
      const build = await createEnvironment(
        org,
        fullName,
        { name: label.trim(), script },
        settings,
      );
      onCreated(build);
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
          title="New Repo Ablation"
          titleId="create-environment-title"
          description="Builds every approved task with these changes."
          onClose={onClose}
          closeRef={closeButton}
          busy={busy}
        />
        <GenerationSteps step={step} firstStep="Change Tasks" />
        {/* The steps row keeps its own bottom margin, so the body pads only its sides and bottom. */}
        <div className="grid gap-4 px-4 pb-6 sm:px-6">
          {step === 1 ? (
            <div className="grid gap-6">
              <label htmlFor="environment-name" className={fieldStyles}>
                <span className="flex items-center gap-1.5">
                  Name
                  <InfoTooltip label="What this repo ablation changes, as conditions and results will name it." />
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

              <label htmlFor="environment-script" className={fieldStyles}>
                <span className="flex items-center gap-1.5">
                  Setup Script
                  <InfoTooltip label="Bash, run in /app as each task's image is built, before the agent starts. It stops at the first command that fails, so use rm -f for a file some tasks lack. Each task's instruction, hidden tests, and reference solution stay the same." />
                </span>
                <textarea
                  id="environment-script"
                  aria-label="Setup Script"
                  rows={8}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  autoComplete="off"
                  data-1p-ignore
                  placeholder={EXAMPLE_SCRIPT}
                  className={cn(controlStyles, "h-auto resize-y py-2 font-mono leading-6")}
                  value={script}
                  disabled={busy}
                  onChange={(event) => setScript(event.target.value)}
                />
              </label>
              {tooLong && (
                <Notice>
                  The script must be at most {MAX_ENVIRONMENT_SCRIPT_BYTES / 1024} KB.
                </Notice>
              )}
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
              {busy ? "Starting…" : step === 1 ? "Continue" : "Build Repo Ablation"}
            </Button>
          </div>
        </DialogFooter>
      </section>
    </Dialog>
  );
}
