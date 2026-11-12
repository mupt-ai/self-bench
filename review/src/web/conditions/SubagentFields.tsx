import { DEFAULT_SUBAGENT_PROMPT, MAX_SUBAGENT_PROMPT } from "../../../../src/contracts/conditions";
import { ModelPicker } from "../ModelPicker";
import { cn } from "../primitives/cn";
import { InfoTooltip } from "../primitives/tooltip";
import { Button, controlStyles, fieldStyles } from "../ui";
import { type ConditionDraft, subagentOn } from "./condition-draft";

/**
 * A condition's subagent model and delegation prompt. With a model, the harness's delegated
 * agents call it instead of the run's own, and the prompt is what the harness is told about
 * delegating: it starts as the one every such run was told, and may be rewritten or emptied.
 */
export function SubagentFields({
  models,
  value,
  disabled,
  onChange,
}: {
  models: { id: string; label: string }[];
  value: ConditionDraft["subagent"];
  disabled: boolean;
  onChange: (value: ConditionDraft["subagent"]) => void;
}) {
  // A model the catalog no longer lists still shows, by its id, until another is picked.
  const listed =
    value && !models.some((model) => model.id === value.catalogId)
      ? [{ id: value.catalogId, label: value.catalogId }, ...models]
      : models;
  return (
    <fieldset
      disabled={disabled}
      aria-label="Subagents"
      className="grid min-w-0 gap-4 border-0 p-0"
    >
      <div className={fieldStyles}>
        <span className="flex items-center gap-1.5">
          Subagent Model
          <InfoTooltip label="The model the harness's subagents run on, through SelfBench's gateway, at that model's default reasoning level. A trial's cost covers both models. A condition with one runs only on Claude Code and Codex, and skips a row whose own model it is." />
        </span>
        <div className="flex gap-2">
          <div className="min-w-0 flex-1">
            <ModelPicker
              label="Subagent Model"
              placeholder="Same as the Run's Model"
              models={listed}
              value={value?.catalogId ?? ""}
              onSelect={(model) => onChange(subagentOn(model.id, value?.prompt))}
            />
          </div>
          {value && (
            <Button variant="ghost" onClick={() => onChange(undefined)}>
              Clear
            </Button>
          )}
        </div>
      </div>
      {value && (
        <div className={fieldStyles}>
          <div className="flex items-center gap-1.5">
            <label htmlFor="condition-subagent-prompt">Delegation Prompt</label>
            <InfoTooltip label="Added to the harness's system prompt, so it hands part of each task to a subagent: left to itself it may do the whole task on the run's own model. Leave it empty to tell the harness nothing." />
            {value.prompt !== DEFAULT_SUBAGENT_PROMPT && (
              <Button
                size="small"
                variant="ghost"
                className="ml-auto"
                onClick={() => onChange(subagentOn(value.catalogId))}
              >
                Reset to Default
              </Button>
            )}
          </div>
          <textarea
            id="condition-subagent-prompt"
            aria-label="Delegation Prompt"
            rows={4}
            maxLength={MAX_SUBAGENT_PROMPT}
            className={cn(controlStyles, "h-auto resize-y py-2")}
            value={value.prompt}
            onChange={(event) => onChange(subagentOn(value.catalogId, event.target.value))}
          />
        </div>
      )}
    </fieldset>
  );
}
