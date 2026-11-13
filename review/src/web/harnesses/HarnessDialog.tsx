import React from "react";
import { DEFAULT_SUBAGENT_PROMPT, SKILL_HARNESSES } from "../../../../src/contracts/conditions";
import {
  type HarnessOptionValue,
  harnessOptionsFor,
} from "../../../../src/contracts/harness-options";
import type { CredentialInfo } from "../../../../src/db/credentials";
import { type Harness, harnessIds, harnessLabels } from "../../../../src/evaluation/models";
import { subagentSupport } from "../../../../src/evaluation/subagents";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "../Dialog";
import { InfoTooltip } from "../primitives/tooltip";
import { Button, fieldStyles, Input, Notice, Select } from "../ui";
import { HarnessOptionFields } from "./HarnessOptionFields";
import { InstructionsField, type Page, PageSteps, SkillFields } from "./HarnessPages";
import { type SavedHarness, saveHarness } from "./harness-api";
import {
  blankHarness,
  draftOf,
  type HarnessDraft,
  harnessProblem,
  submittedHarness,
  withAgent,
} from "./harness-draft";
import { SubagentFields, staleSubagentCredential } from "./SubagentFields";

/**
 * A saved harness's editor: its name and the changes it makes to one agent, which every run that
 * picks it applies to every task, with the credential its subagent model runs on. Nothing here
 * names a repository or an environment: those are the run's.
 */
export function HarnessDialog({
  org,
  harness: editing,
  subagentModels,
  credentials,
  onClose,
  onSaved,
}: {
  org: string;
  /** The harness to edit; none for a new one. */
  harness?: SavedHarness;
  subagentModels: { id: string; label: string }[];
  /** The workspace's credentials; undefined until they load. */
  credentials: readonly CredentialInfo[] | undefined;
  onClose: () => void;
  onSaved: (saved: SavedHarness) => void;
}) {
  const [draft, setDraft] = React.useState<HarnessDraft>(() =>
    editing ? draftOf(editing) : blankHarness(),
  );
  const [busy, setBusy] = React.useState(false);
  const [page, setPage] = React.useState<Page>(1);
  const [error, setError] = React.useState<string | null>(null);
  const closeButton = React.useRef<HTMLButtonElement>(null);
  const problem =
    harnessProblem(draft) ??
    (staleSubagentCredential(draft, credentials)
      ? "Choose a credential that serves the subagent model."
      : undefined);
  const update = (patch: Partial<HarnessDraft>) => setDraft({ ...draft, ...patch });
  const harness = draft.agent;
  const skillsOn = !!harness && SKILL_HARNESSES.includes(harness);
  const subagentOn = !!harness && subagentSupport[harness].configurable;
  const optionsOn = !!harness && harnessOptionsFor(harness).length > 0;
  // A harness's options are kept as typed, so a value set under one harness stays put when another is picked.
  const setOption = (name: string, value: string | undefined) => {
    if (!harness) return;
    const { [name]: _, ...rest } = draft.harnessOptions[harness] ?? {};
    const next: Record<string, HarnessOptionValue> =
      value === undefined ? rest : { ...rest, [name]: value };
    setDraft({ ...draft, harnessOptions: { ...draft.harnessOptions, [harness]: next } });
  };

  const submit = async () => {
    if (busy || problem) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await saveHarness(org, submittedHarness(draft), editing?.id));
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
      aria-labelledby="harness-title"
    >
      <section className="flex min-w-0 flex-col" aria-labelledby="harness-title">
        <DialogHeader
          title={editing ? "Edit Harness" : "New Harness"}
          titleId="harness-title"
          description="Changes to an agent that a run applies to every task, beside the baseline."
          onClose={onClose}
          closeRef={closeButton}
          busy={busy}
        />
        <DialogBody className="grid gap-6 space-y-0">
          <PageSteps page={page} disabled={busy} onPick={setPage} />
          {page === 1 && (
            <>
              <label htmlFor="harness-name" className={fieldStyles}>
                <span className="flex items-center gap-1.5">
                  Name
                  <InfoTooltip label="What this harness changes, as the Run page and results will name it." />
                </span>
                <Input
                  id="harness-name"
                  aria-label="Name"
                  autoComplete="off"
                  data-1p-ignore
                  maxLength={60}
                  placeholder="With Next.js Skills"
                  value={draft.name}
                  disabled={busy}
                  onChange={(event) => update({ name: event.target.value })}
                />
              </label>
              <label htmlFor="harness-agent" className={fieldStyles}>
                <span className="flex items-center gap-1.5">
                  Agent
                  <InfoTooltip label="The agent this harness changes. Its skills, options, and subagent model are for it alone, so a run with other agents leaves them out." />
                </span>
                <Select
                  id="harness-agent"
                  aria-label="Agent"
                  value={harness ?? ""}
                  disabled={busy}
                  onChange={(event) => {
                    const next = harnessIds.find((entry) => entry === event.target.value);
                    if (next) setDraft(withAgent(draft, next));
                    else update({ agent: undefined });
                  }}
                >
                  <option value="">Choose an Agent</option>
                  {harnessIds.map((entry: Harness) => (
                    <option key={entry} value={entry}>
                      {harnessLabels[entry]}
                    </option>
                  ))}
                </Select>
              </label>
            </>
          )}
          {page === 2 &&
            (harness && optionsOn ? (
              <HarnessOptionFields
                harness={harness}
                options={draft.harnessOptions[harness] ?? {}}
                idPrefix={`harness-${harness}`}
                disabled={busy}
                onSet={setOption}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                {harness
                  ? `${harnessLabels[harness]} has no options to set.`
                  : "Pick an agent to set its options."}
              </p>
            ))}
          {page === 3 && (
            <>
              {skillsOn && (
                <SkillFields
                  skills={draft.skills}
                  disabled={busy}
                  onChange={(skills) => update({ skills })}
                />
              )}
              <InstructionsField
                draft={draft}
                disabled={busy}
                onChange={(patch) => update(patch)}
              />
              {subagentOn && harness && (
                <SubagentFields
                  agent={harness}
                  models={subagentModels}
                  credentials={credentials}
                  value={draft.subagent}
                  disabled={busy}
                  onChange={(subagent) => {
                    const { subagent: _, ...rest } = draft;
                    // A first subagent model starts the instructions on the delegation prompt, in
                    // the system prompt, where the harness has always been told it.
                    const prompt =
                      subagent && !draft.subagent && !draft.instructions.trim()
                        ? {
                            instructions: DEFAULT_SUBAGENT_PROMPT,
                            instructionsWhere: "system" as const,
                          }
                        : {};
                    setDraft(subagent ? { ...rest, ...prompt, subagent } : rest);
                  }}
                />
              )}
            </>
          )}
          {error && <Notice>{error}</Notice>}
        </DialogBody>
        <DialogFooter className="sticky bottom-0 justify-between">
          <span className="text-sm text-muted-foreground" role="status">
            {problem ?? ""}
          </span>
          <span className="flex gap-2">
            {page > 1 && (
              <Button variant="ghost" disabled={busy} onClick={() => setPage((page - 1) as Page)}>
                Back
              </Button>
            )}
            {page < 3 ? (
              <Button
                variant="primary"
                disabled={busy || !draft.name.trim()}
                onClick={() => setPage((page + 1) as Page)}
              >
                Next
              </Button>
            ) : (
              <Button variant="primary" disabled={busy || !!problem} onClick={() => void submit()}>
                {busy ? "Saving…" : editing ? "Save Changes" : "Save Harness"}
              </Button>
            )}
          </span>
        </DialogFooter>
      </section>
    </Dialog>
  );
}
