import { Button, Notice } from "../ui";

/** A started comparison's tasks close to the sandbox's resource limits, or that it rounds. */
export function ResourceWarnings({
  warnings,
  onContinue,
}: {
  warnings: readonly string[];
  onContinue(): void;
}) {
  if (!warnings.length) return null;
  return (
    <Notice className="mb-5">
      <p className="font-semibold">Started, with resource warnings:</p>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        {warnings.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
      <Button className="mt-3" variant="primary" onClick={onContinue}>
        Continue to Results
      </Button>
    </Notice>
  );
}
