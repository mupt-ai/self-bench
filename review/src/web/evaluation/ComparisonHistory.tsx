import React from "react";
import { Link } from "react-router";
import { DataTable, SectionHeader } from "../ui";
import { evaluationRequest } from "./api";
import type { ComparisonStatus } from "./ComparisonPage";

export function ComparisonHistory({ repo, url }: { repo: string; url: string }) {
  const [comparisons, setComparisons] = React.useState<ComparisonStatus[]>([]);
  const [error, setError] = React.useState("");
  // The comparisons sit below the results table, so they load once the page is scrolled near
  // them: opening the page does not wait on, or pay for, a list nobody may look at.
  const anchor = React.useRef<HTMLDivElement>(null);
  const [near, setNear] = React.useState(false);
  React.useEffect(() => {
    const element = anchor.current;
    if (near || !element) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      // The repository page scrolls inside its own pane; the margin starts the load a little
      // before the section is reached.
      {
        root: element.closest<HTMLElement>('[data-slot="repository-content"]'),
        rootMargin: "300px",
      },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [near]);
  React.useEffect(() => {
    if (!near) return;
    let disposed = false;
    evaluationRequest<{ comparisons: ComparisonStatus[] }>(`${url}/comparisons`).then(
      (result) => {
        // Newest first, as the API lists them.
        if (!disposed) setComparisons(result.comparisons);
      },
      () => {
        if (!disposed)
          setError("Saved comparisons could not be loaded. Every run is still in the table above.");
      },
    );
    return () => {
      disposed = true;
    };
  }, [url, near]);
  // A pixel tall: some browsers never report a marker with no area as in view.
  if (!comparisons.length && !error)
    return <div ref={anchor} className="h-px" aria-hidden="true" />;
  return (
    <section className="mt-6">
      <SectionHeader title="Saved Comparisons" />
      {error && <p className="mt-2 text-sm text-muted-foreground">{error}</p>}
      <div className="mt-3 [&_a]:font-medium [&_a]:text-foreground [&_a:hover]:underline [&_a:hover]:underline-offset-4">
        <DataTable>
          <thead>
            <tr>
              <th>Created</th>
              <th>Models</th>
              <th>Finished Trials</th>
              <th>Open</th>
            </tr>
          </thead>
          <tbody>
            {comparisons.map((comparison) => (
              <tr key={comparison.id}>
                <td className="whitespace-nowrap">
                  {new Date(comparison.createdAt).toLocaleString()}
                </td>
                <td className="max-w-md">
                  <span
                    className="block truncate font-mono text-xs"
                    title={comparison.runs.map((run) => run.model).join(", ")}
                  >
                    {comparison.runs.map((run) => run.model).join(", ")}
                  </span>
                </td>
                <td className="font-mono tabular-nums">
                  {comparison.runs.reduce((sum, run) => sum + run.completed, 0)} /{" "}
                  {comparison.runs.reduce((sum, run) => sum + run.trials, 0)}
                </td>
                <td>
                  <Link to={`/repos/${repo}/comparisons/${comparison.id}`}>View Comparison →</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </div>
    </section>
  );
}
