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
    <section className="mt-8">
      <SectionHeader title="Saved Comparisons" />
      {error && <p className="mt-2 text-sm text-muted-foreground">{error}</p>}
      <div className="mt-3 font-mono [&_a]:text-foreground [&_a:hover]:text-brand [&_button]:text-foreground [&_button:hover]:text-brand">
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
                <td>{new Date(comparison.createdAt).toLocaleString()}</td>
                <td>{comparison.runs.map((run) => run.model).join(", ")}</td>
                <td>
                  {comparison.runs.reduce((sum, run) => sum + run.completed, 0)} /{" "}
                  {comparison.runs.reduce((sum, run) => sum + run.trials, 0)}
                </td>
                <td>
                  <Link to={`/repos/${repo}/comparisons/${comparison.id}`}>
                    View Status / Resume →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </div>
    </section>
  );
}
