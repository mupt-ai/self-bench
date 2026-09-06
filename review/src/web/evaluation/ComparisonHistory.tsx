import React from "react";
import { Link } from "react-router";
import { DataTable } from "../ui";
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
    <section className="mt-8 [&_h2]:mb-4">
      <h2>Saved comparisons</h2>
      {error && <p className="mt-2 text-[13px] text-muted">{error}</p>}
      <div className="mt-3 font-mono [&_a]:text-ink [&_a:hover]:text-mint [&_button]:text-ink [&_button:hover]:text-mint mt-8 [&_h2]:mb-4">
        <DataTable>
          <thead>
            <tr>
              <th>Created</th>
              <th>Models</th>
              <th>Completed trials</th>
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
                    View status / resume →
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
