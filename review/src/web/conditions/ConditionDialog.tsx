import { Plus, Trash2 } from "lucide-react";
import React from "react";
import { MAX_SKILL_LENGTH, MAX_SKILLS } from "../../../../src/contracts/conditions";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "../Dialog";
import { cn } from "../primitives/cn";
import { InfoTooltip } from "../primitives/tooltip";
import { Button, controlStyles, fieldStyles, Input, Notice } from "../ui";
import { type SavedCondition, saveCondition } from "./condition-api";
import {
  blankCondition,
  type ConditionDraft,
  conditionProblem,
  draftOf,
  submittedCondition,
} from "./condition-draft";
import { HarnessOptionsEditor } from "./HarnessOptionsEditor";
import { SubagentFields } from "./SubagentFields";

/**
 * A saved condition's editor: its name and the harness changes it makes, which every run that
 * picks it applies to every task. Nothing here names a repository, an environment, or a
 * credential: those are the run's.
 */
export function ConditionDialog({
  org,
  condition,
  subagentModels,
  onClose,
  onSaved,
}: {
  org: string;
  /** The condition to edit; none for a new one. */
  condition?: SavedCondition;
  subagentModels: { id: string; label: string }[];
  onClose: () => void;
  onSaved: (saved: SavedCondition) => void;
}) {
  const [draft, setDraft] = React.useState<ConditionDraft>(() =>
    condition ? draftOf(condition) : blankCondition(),
  );
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const closeButton = React.useRef<HTMLButtonElement>(null);
  const problem = conditionProblem(draft);
  const update = (patch: Partial<ConditionDraft>) => setDraft({ ...draft, ...patch });

  const submit = async () => {
    if (busy || problem) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await saveCondition(org, submittedCondition(draft), condition?.id));
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
      aria-labelledby="condition-title"
    >
      <section className="flex min-w-0 flex-col" aria-labelledby="condition-title">
        <DialogHeader
          title={condition ? "Edit Condition" : "New Condition"}
          titleId="condition-title"
          description="Harness changes a run applies to every task, beside the baseline."
          onClose={onClose}
          closeRef={closeButton}
          busy={busy}
        />
        <DialogBody className="grid gap-6 space-y-0">
          <label htmlFor="condition-name" className={fieldStyles}>
            <span className="flex items-center gap-1.5">
              Name
              <InfoTooltip label="What this condition changes, as the Run page and results will name it." />
            </span>
            <Input
              id="condition-name"
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
          <div className={fieldStyles}>
            <span className="flex items-center gap-1.5">
              Skills
              <InfoTooltip label="A GitHub repository whose skills/ folder holds the skills, as org/repo, org/repo@ref, or a URL. Claude Code, Codex, and Pi load them." />
            </span>
            {draft.skills.map((skill, at) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own.
                key={at}
                className="flex gap-2"
              >
                <Input
                  aria-label={`Skill ${at + 1}`}
                  className="font-mono"
                  maxLength={MAX_SKILL_LENGTH}
                  placeholder="vercel/next.js@canary"
                  value={skill}
                  disabled={busy}
                  onChange={(event) =>
                    update({
                      skills: draft.skills.map((value, row) =>
                        row === at ? event.target.value : value,
                      ),
                    })
                  }
                />
                <Button
                  variant="ghost"
                  aria-label={`Remove Skill ${at + 1}`}
                  disabled={busy}
                  onClick={() => update({ skills: draft.skills.filter((_, row) => row !== at) })}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </div>
            ))}
            {draft.skills.length < MAX_SKILLS && (
              <div>
                <Button
                  size="small"
                  disabled={busy}
                  onClick={() => update({ skills: [...draft.skills, ""] })}
                >
                  <Plus aria-hidden="true" />
                  Add Skill
                </Button>
              </div>
            )}
          </div>
          <label htmlFor="condition-instructions" className={fieldStyles}>
            <span className="flex items-center gap-1.5">
              Extra Instructions
              <InfoTooltip label="Appended to every task's instruction under this condition." />
            </span>
            <textarea
              id="condition-instructions"
              aria-label="Extra Instructions"
              rows={3}
              maxLength={4000}
              className={cn(controlStyles, "h-auto resize-y py-2")}
              placeholder="For example: read node_modules/next/dist/docs before changing caching."
              value={draft.instructions}
              disabled={busy}
              onChange={(event) => update({ instructions: event.target.value })}
            />
          </label>
          <SubagentFields
            models={subagentModels}
            value={draft.subagent}
            disabled={busy}
            onChange={(subagent) => {
              const { subagent: _, ...rest } = draft;
              setDraft(subagent ? { ...rest, subagent } : rest);
            }}
          />
          <fieldset disabled={busy} className="min-w-0 border-0 p-0" aria-label="Harness Options">
            <HarnessOptionsEditor
              value={draft.harnessOptions}
              idPrefix="condition"
              onChange={(harnessOptions) => update({ harnessOptions })}
            />
          </fieldset>
          {error && <Notice>{error}</Notice>}
        </DialogBody>
        <DialogFooter className="sticky bottom-0 justify-between">
          <span className="text-sm text-muted-foreground" role="status">
            {problem ?? ""}
          </span>
          <Button variant="primary" disabled={busy || !!problem} onClick={() => void submit()}>
            {busy ? "Saving…" : condition ? "Save Changes" : "Save Condition"}
          </Button>
        </DialogFooter>
      </section>
    </Dialog>
  );
}
