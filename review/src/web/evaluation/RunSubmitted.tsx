import { Link } from "react-router";
import { Button } from "../ui";

/** The Run page's settings once submitted: resume the same request, or start a new one. */
export function RunSubmitted({
  pages,
  busy,
  onResume,
  onNew,
}: {
  pages: string;
  busy: boolean;
  onResume: () => void;
  onNew: () => void;
}) {
  return (
    <div className="panel mb-5 flex flex-wrap items-center justify-between gap-3 p-4">
      <p className="text-sm">These settings belong to a submitted request.</p>
      <div className="flex flex-wrap items-center gap-3">
        <Link
          className="text-sm font-semibold text-foreground underline underline-offset-4"
          to={`${pages}/results`}
        >
          View Results
        </Link>
        <Button type="button" variant="primary" disabled={busy} onClick={onResume}>
          {busy ? "Resuming…" : "Resume Submission"}
        </Button>
        <Button type="button" disabled={busy} onClick={onNew}>
          New Comparison
        </Button>
      </div>
    </div>
  );
}
