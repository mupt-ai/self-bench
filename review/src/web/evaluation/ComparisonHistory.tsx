import React from "react";
import { Link } from "react-router";
import { DataTable, SectionHeader } from "../ui";
import { evaluationRequest } from "./api";
import type { ComparisonStatus } from "./ComparisonPage";

export function ComparisonHistory({ repo, url }: { repo: string; url: string }) {
  const [comparisons, setComparisons] = React.useState<ComparisonStatus[]>([]);
  const [error, setError] = React.useState("");
  React.useEffect(() => {
    let disposed = false;
    evaluationRequest<{ comparisons: ComparisonStatus[] }>(`${url}/comparisons`).then(
      (result) => {
        if (!disposed) setComparisons(result.comparisons.slice().reverse());
      },
      () => {
        if (!disposed)
          setError("Saved comparisons could not be loaded. Individual runs remain below.");
      },
    );
    return () => {
      disposed = true;
    };
  }, [url]);
  if (!comparisons.length && !error) return null;
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
              <th>Completed Trials</th>
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
