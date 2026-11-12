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
import { InfoTooltip } from "./primitives/tooltip";
import type { SiteOrg } from "./session";
import { addScenario, type ScenarioInput } from "./task-start-api";
import { Button, controlStyles, fieldStyles, Input, Notice, Select } from "./ui";
import { useGenerationSettings } from "./useGenerationSettings";

/** Where the agent starts: the repository at a commit, or files the author writes. */
export type ScenarioStart = "repository" | "workspace";

export interface AddScenarioSheetProps {
  org: SiteOrg;
  fullName: string;
  start: ScenarioStart;
  onClose: () => void;
  onComplete: () => void;
}

const COPY = {
  repository: {
    heading: "Add Vibe Eval",
    about:
      "Describe a change to make in this repository, ideally one an agent got wrong. The agent starts from the repository at the commit you choose; the author writes the instruction, a reference implementation, and hidden tests.",
    titlePlaceholder: "Personalised Dashboard on Cache Components",
    scenarioPlaceholder:
      "For example: our team dashboard awaits all its data at the top of the page, so it blocks for two seconds. Enable Cache Components and make it load fast, without leaking one member's data to another.",
  },
  workspace: {
    heading: "Add Workspace Vibe Eval",
    about:
      "Describe a task an agent should handle, ideally one it got wrong, with any real files from it. The author builds the files the agent starts with, the instruction, and hidden tests that check the outcome.",
    titlePlaceholder: "CSV Import Drops Quoted Rows",
    scenarioPlaceholder:
      'For example: our CSV import silently drops any row whose fields contain a quoted comma, like "Smith, Jane". Attached are the export that loses rows and the stack trace. Asked to fix it, my agent split each line on commas. Fix the parser so every row imports.',
  },
} as const;

/**
 * A described scenario becomes one task, verified as a PR's is. A repository scenario starts the
 * agent from the repository at a commit; a workspace scenario's author writes the files it starts
 * with.
 */
export function AddScenarioSheet({
  org,
  fullName,
  start,
  onClose,
  onComplete,
}: AddScenarioSheetProps) {
  const copy = COPY[start];
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
  const [commit, setCommit] = React.useState("");
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
        {
          title: title.trim(),
          scenario: scenario.trim(),
          difficulty,
          attachments,
          // GitHub resolves HEAD to the default branch's latest commit.
          ...(start === "repository" ? { commit: commit.trim() || "HEAD" } : {}),
        },
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
          title={copy.heading}
          titleId="add-scenario-title"
          description={<span className="font-mono">{fullName}</span>}
          onClose={onClose}
          closeRef={closeButton}
          busy={busy}
        />
        <GenerationSteps step={step} firstStep="Describe Vibe Eval" />
        <div className="px-4 pb-6 sm:px-6">
          {step === 1 ? (
            <div className="grid gap-4">
              <div
                className={cn(
                  "grid gap-4",
                  start === "repository" && "sm:grid-cols-[minmax(0,1fr)_16rem]",
                )}
              >
                <label htmlFor="scenario-title" className={fieldStyles}>
                  Title
                  <Input
                    id="scenario-title"
                    maxLength={MAX_SCENARIO_TITLE_LENGTH}
                    placeholder={copy.titlePlaceholder}
                    value={title}
                    disabled={busy}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                </label>
                {start === "repository" && (
                  <label htmlFor="scenario-commit" className={fieldStyles}>
                    <span className="flex items-center gap-1.5">
                      Commit
                      <InfoTooltip label="A commit SHA or branch the agent starts from. Leave it blank for the default branch's latest commit. The task is pinned to the commit it resolves to." />
                    </span>
                    <Input
                      id="scenario-commit"
                      aria-label="Commit"
                      className="font-mono"
                      placeholder="Default Branch"
                      value={commit}
                      disabled={busy}
                      onChange={(event) => setCommit(event.target.value)}
                    />
                  </label>
                )}
              </div>
              <label htmlFor="scenario-text" className={fieldStyles}>
                <span className="flex items-center gap-1.5">
                  Description
                  <InfoTooltip label={copy.about} />
                </span>
                <textarea
                  id="scenario-text"
                  aria-label="Description"
                  rows={9}
                  maxLength={MAX_SCENARIO_LENGTH}
                  placeholder={copy.scenarioPlaceholder}
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
                  <span className="flex items-center gap-1.5">
                    Attachments
                    <InfoTooltip
                      label={`Optional real files from the situation, such as a log, a design, or the emails: up to ${MAX_ATTACHMENTS} files and ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB. Details the vibe eval doesn't depend on are replaced with fictional ones.`}
                    />
                  </span>
                  <Input
                    id="scenario-files"
                    aria-label="Attachments"
                    type="file"
                    multiple
                    disabled={busy}
                    className="py-1.5"
                    onChange={(event) => setFiles([...(event.target.files ?? [])])}
                  />
                </label>
              </div>
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
