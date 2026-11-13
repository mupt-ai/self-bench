import { Plus, Trash2 } from "lucide-react";
import { MAX_SKILL_LENGTH, MAX_SKILLS } from "../../../../src/contracts/conditions";
import { InfoTooltip } from "../primitives/tooltip";
import { Button, fieldStyles, Input } from "../ui";

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
            <Trash2 aria-hidden="true" />
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
