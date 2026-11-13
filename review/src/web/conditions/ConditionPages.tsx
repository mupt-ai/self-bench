import { Plus } from "lucide-react";
import { MAX_SKILL_LENGTH, MAX_SKILLS } from "../../../../src/contracts/conditions";
import { harnessLabels } from "../../../../src/evaluation/models";
import { cn } from "../primitives/cn";
import { InfoTooltip } from "../primitives/tooltip";
import { Button, controlStyles, fieldStyles, Input, Select } from "../ui";
import { type ConditionDraft, instructionsWhere, systemPromptOption } from "./condition-draft";

export type Page = 1 | 2 | 3;
const PAGES = ["Harness", "Options", "Skills and Instructions"] as const;

/** The condition editor's pages, each a step that can be opened directly. */
export function PageSteps({
  page,
  disabled,
  onPick,
}: {
  page: Page;
  disabled: boolean;
  onPick: (page: Page) => void;
}) {
  return (
    <ol
      aria-label="Condition Steps"
      className="flex gap-6 border-b border-border pb-4 text-sm font-medium"
    >
      {PAGES.map((label, index) => (
        <li key={label}>
          <button
            type="button"
            disabled={disabled}
            aria-current={page === index + 1 ? "step" : undefined}
            className={
              page === index + 1 ? "text-foreground" : "text-muted-foreground hover:text-foreground"
            }
            onClick={() => onPick((index + 1) as Page)}
          >
            {index + 1}. {label}
          </button>
        </li>
      ))}
    </ol>
  );
}

/** A condition's skill sources, one row each. */
export function SkillFields({
  skills,
  disabled,
  onChange,
}: {
  skills: string[];
  disabled: boolean;
  onChange: (skills: string[]) => void;
}) {
  return (
    <div className={fieldStyles}>
      <span className="flex items-center gap-1.5">
        Skills
        <InfoTooltip label="A GitHub repository whose skills/ folder holds the skills, as org/repo, org/repo@ref, or a URL. Claude Code, Codex, and Pi load them." />
      </span>
      {skills.map((skill, at) => (
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
            disabled={disabled}
            onChange={(event) =>
              onChange(skills.map((value, row) => (row === at ? event.target.value : value)))
            }
          />
          <Button
            variant="ghost"
            aria-label={`Remove Skill ${at + 1}`}
            disabled={disabled}
            onClick={() => onChange(skills.filter((_, row) => row !== at))}
          >
            Remove
          </Button>
        </div>
      ))}
      {skills.length < MAX_SKILLS && (
        <div>
          <Button size="small" disabled={disabled} onClick={() => onChange([...skills, ""])}>
            <Plus aria-hidden="true" />
            Add Skill
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * A condition's instructions, and where they go: the end of each task's prompt, which every
 * harness reads, or the harness's system prompt, where it has one (Claude Code's append_system_prompt).
 */
export function InstructionsField({
  draft,
  disabled,
  onChange,
}: {
  draft: ConditionDraft;
  disabled: boolean;
  onChange: (patch: Partial<ConditionDraft>) => void;
}) {
  const system = !!systemPromptOption(draft.harness);
  return (
    <div className={fieldStyles}>
      <div className="flex items-center gap-3">
        <label htmlFor="condition-instructions" className="flex flex-1 items-center gap-1.5">
          Instructions
          <InfoTooltip
            label={
              system
                ? "Task Prompt adds them to the end of every task's instruction. System Prompt appends them to the harness's system prompt instead."
                : "Added to the end of every task's instruction under this condition."
            }
          />
        </label>
        {system && draft.harness && (
          <span className="w-40">
            <Select
              aria-label="Instructions Go In"
              value={instructionsWhere(draft)}
              disabled={disabled}
              onChange={(event) =>
                onChange({ instructionsWhere: event.target.value === "system" ? "system" : "task" })
              }
            >
              <option value="task">Task Prompt</option>
              <option value="system">{harnessLabels[draft.harness]} System Prompt</option>
            </Select>
          </span>
        )}
      </div>
      <textarea
        id="condition-instructions"
        aria-label="Instructions"
        rows={3}
        maxLength={4000}
        className={cn(controlStyles, "h-auto resize-y py-2")}
        placeholder="For example: read node_modules/next/dist/docs before changing caching."
        value={draft.instructions}
        disabled={disabled}
        onChange={(event) => onChange({ instructions: event.target.value })}
      />
    </div>
  );
}
