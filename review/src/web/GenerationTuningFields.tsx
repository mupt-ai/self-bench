import { DEFAULT_AUTHORING_ROUNDS, MAX_AUTHORING_ROUNDS } from "../../../src/contracts/verify";
import type { GenerationSettings } from "../../../src/generation/settings/settings";
import { InfoTooltip } from "./primitives/tooltip";
import { fieldStyles, Select } from "./ui";

const pairRow = "grid min-w-0 gap-6 sm:grid-cols-2";

/** Reasoning effort, author → verify → review rounds per candidate, and how deep verify goes. */
export function TuningFields({
  value,
  onChange,
}: {
  value: GenerationSettings;
  onChange: (value: GenerationSettings) => void;
}) {
  return (
    <div className={pairRow}>
      <label htmlFor="generation-reasoning" className={`${fieldStyles} content-start`}>
        Reasoning
        <Select
          id="generation-reasoning"
          aria-label="Reasoning"
          value={value.reasoning}
          onChange={(event) =>
            onChange({
              ...value,
              reasoning: event.target.value as GenerationSettings["reasoning"],
            })
          }
        >
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </Select>
      </label>
      <label htmlFor="generation-authoring-rounds" className={`${fieldStyles} content-start`}>
        <span className="flex items-center gap-1.5">
          Authoring Rounds
          <InfoTooltip label="Each round, the author writes the task, the worker verifies it, and an independent reviewer accepts it or sends it back. A candidate stops at its first acceptance and is rejected after the last round." />
        </span>
        <Select
          id="generation-authoring-rounds"
          aria-label="Authoring Rounds"
          value={value.authoringRounds ?? DEFAULT_AUTHORING_ROUNDS}
          onChange={(event) => onChange({ ...value, authoringRounds: Number(event.target.value) })}
        >
          {Array.from({ length: MAX_AUTHORING_ROUNDS }, (_, index) => index + 1).map((rounds) => (
            <option key={rounds} value={rounds}>
              {rounds}
            </option>
          ))}
        </Select>
      </label>
      <label htmlFor="generation-verification" className={`${fieldStyles} content-start`}>
        <span className="flex items-center gap-1.5">
          Verification
          <InfoTooltip label="Full builds the task image and runs the smoke, nop, and oracle checks in Harbor. Static Only runs the compiler, environment policy, and audit and builds nothing: faster and cheaper, but tasks are not proven to run." />
        </span>
        <Select
          id="generation-verification"
          aria-label="Verification"
          value={value.verification ?? "full"}
          onChange={(event) =>
            onChange({
              ...value,
              verification: event.target.value as NonNullable<GenerationSettings["verification"]>,
            })
          }
        >
          <option value="full">Full</option>
          <option value="static">Static Only</option>
        </Select>
      </label>
    </div>
  );
}
