import { InfoTooltip } from "../primitives/tooltip";
import { fieldStyles, Input } from "../ui";

/** An E2B account's optional limit on template builds at once; blank means none. */
export function BuildLimitField({
  value,
  onChange,
}: {
  value: number | undefined;
  onChange(value: number | undefined): void;
}) {
  return (
    <label className={fieldStyles} htmlFor="credential-max-builds">
      <span className="flex items-center gap-1.5">
        Max Concurrent Builds
        <InfoTooltip label="Evaluations build each task's template once before its trials, and E2B counts those builds apart from sandboxes. Use your plan's limit, such as 20 on E2B Hobby. Leave blank for no limit. A new limit leaves started work running." />
      </span>
      <Input
        id="credential-max-builds"
        aria-label="Max Concurrent Builds"
        type="number"
        inputMode="numeric"
        min={1}
        max={1000}
        step={1}
        placeholder="No Limit"
        value={value ?? ""}
        onChange={(event) =>
          onChange(event.target.value === "" ? undefined : Number(event.target.value))
        }
      />
    </label>
  );
}
