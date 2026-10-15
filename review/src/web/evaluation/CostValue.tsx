import { InfoTooltip } from "../primitives/tooltip";
import { dollars } from "./benchmark";

/** Keep the amount compact while making lower-bound accounting explicit on hover or focus. */
export function CostValue({ value, incomplete }: { value: number; incomplete?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      {dollars(value)}
      {incomplete && (
        <InfoTooltip
          label="Incomplete Cost"
          content="This is known spend, not a complete total. Some requests have no recorded price, so the actual cost may be higher."
          className="shrink-0"
          onTriggerClick={(event) => event.stopPropagation()}
        />
      )}
    </span>
  );
}
