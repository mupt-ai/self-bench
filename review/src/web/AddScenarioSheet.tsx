import React from "react";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_SCENARIO_LENGTH,
  MAX_SCENARIO_TITLE_LENGTH,
} from "../../../src/contracts/task";
import { Dialog, DialogFooter, DialogHeader } from "./Dialog";
import { GenerationFields } from "./GenerationFields";
import { GenerationSteps } from "./GenerationSteps";
import { cn } from "./primitives/cn";
import type { SiteOrg } from "./session";
import { addScenario, type ScenarioInput } from "./task-start-api";
import { Button, controlStyles, fieldStyles, Input, Notice, Select } from "./ui";
import { useGenerationSettings } from "./useGenerationSettings";

export interface AddScenarioSheetProps {
  org: SiteOrg;
  fullName: string;
  onClose: () => void;
  onComplete: () => void;
}

/**
 * A described scenario becomes one task: the pipeline writes the workspace the agent starts in,
 * the instruction, and the hidden tests, and verifies them as it does a PR's.
 */
export function AddScenarioSheet({ org, fullName, onClose, onComplete }: AddScenarioSheetProps) {
  const [step, setStep] = React.useState<1 | 2>(1);
  const {
    settings,
    setSettings,
    options,
    error: optionsError,
    valid,
    reload,
  } = useGenerationSettings(org.login, fullName);
  const [title, setTitle] = React.useState("");
  const [scenario, setScenario] = React.useState("");
  const [difficulty, setDifficulty] = React.useState<ScenarioInput["difficulty"]>("medium");
  const [files, setFiles] = React.useState<File[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const closeButton = React.useRef<HTMLButtonElement>(null);
  const bytes = files.reduce((total, file) => total + file.size, 0);
  const tooLarge = files.length > MAX_ATTACHMENTS || bytes > MAX_ATTACHMENT_BYTES;
  const described = title.trim().length > 0 && scenario.trim().length > 0 && !tooLarge;

  const submit = async () => {
    if (busy || !described || !valid) return;
    setBusy(true);
    setError(null);
    try {
      const attachments = await Promise.all(
        files.map(async (file) => ({ name: file.name, content: await base64(file) })),
      );
      await addScenario(
        org.login,
        fullName,
        { title: title.trim(), scenario: scenario.trim(), difficulty, attachments },
        settings,
      );
      onComplete();
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
      aria-labelledby="add-scenario-title"
    >
      <section className="flex min-w-0 flex-col" aria-labelledby="add-scenario-title">
        <DialogHeader
          title="Add Scenario"
          titleId="add-scenario-title"
          description={<span className="font-mono">{fullName}</span>}
          onClose={onClose}
          closeRef={closeButton}
          busy={busy}
        />
        <GenerationSteps step={step} firstStep="Describe Scenario" />
        <div className="px-4 pb-6 sm:px-6">
          {step === 1 ? (
            <div className="grid gap-4">
              <p className="text-sm leading-6 text-muted-foreground">
                Describe a situation an agent should handle, ideally one it got wrong. The author
                builds the files the agent starts with, the instruction, and hidden tests that check
                the outcome.
              </p>
              <label htmlFor="scenario-title" className={fieldStyles}>
                Title
                <Input
                  id="scenario-title"
                  maxLength={MAX_SCENARIO_TITLE_LENGTH}
                  placeholder="Traded to a New Team"
                  value={title}
                  disabled={busy}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <label htmlFor="scenario-text" className={fieldStyles}>
                Scenario
                <textarea
                  id="scenario-text"
                  rows={9}
                  maxLength={MAX_SCENARIO_LENGTH}
                  placeholder="For example: my rec league schedule is a spreadsheet that says I'm on team 6. Last week an email said I was traded to team 3. Asked when my next game is, my agent answered from the spreadsheet."
                  className={cn(controlStyles, "h-auto resize-y py-2")}
                  value={scenario}
                  disabled={busy}
                  onChange={(event) => setScenario(event.target.value)}
                />
              </label>
              <div className="grid gap-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
                <label htmlFor="scenario-difficulty" className={fieldStyles}>
                  Difficulty
                  <Select
                    id="scenario-difficulty"
                    value={difficulty}
                    disabled={busy}
                    onChange={(event) =>
                      setDifficulty(event.target.value as ScenarioInput["difficulty"])
                    }
                  >
                    <option value="easy">Easy</option>
                    <option value="medium">Medium</option>
                    <option value="hard">Hard</option>
                  </Select>
                </label>
                <label htmlFor="scenario-files" className={fieldStyles}>
                  Attachments
                  <Input
                    id="scenario-files"
                    type="file"
                    multiple
                    disabled={busy}
                    className="py-1.5"
                    onChange={(event) => setFiles([...(event.target.files ?? [])])}
                  />
                </label>
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                Optional: real files from the situation, such as the spreadsheet or the emails. Up
                to {MAX_ATTACHMENTS} files and {MAX_ATTACHMENT_BYTES / 1024 / 1024} MB. Details the
                scenario doesn't depend on are replaced with fictional ones.
              </p>
              {tooLarge && (
                <Notice>
                  Attach at most {MAX_ATTACHMENTS} files, {MAX_ATTACHMENT_BYTES / 1024 / 1024} MB in
                  all.
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
          {error && <Notice className="mt-4">{error}</Notice>}
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
              disabled={busy || !described || (step === 2 && !valid)}
              onClick={() => (step === 1 ? setStep(2) : void submit())}
            >
              {busy ? "Starting…" : step === 1 ? "Continue" : "Generate Task"}
            </Button>
          </div>
        </DialogFooter>
      </section>
    </Dialog>
  );
}

async function base64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}
