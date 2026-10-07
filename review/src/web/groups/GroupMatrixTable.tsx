import type { EvaluationRun } from "../evaluation/api";
import { DataTable } from "../ui";
import { groupMatrix } from "./group-matrix";

const percent = (value: number | undefined) =>
  value === undefined ? "—" : `${Math.round(value)}%`;
const dollars = (value: number | undefined) =>
  value === undefined ? undefined : `$${value.toFixed(value < 1 ? 3 : 2)} / task`;

/** Repositories as rows and settings as columns, with an average and a pooled row. */
export function GroupMatrixTable({
  repos,
}: {
  repos: readonly { fullName: string; runs: EvaluationRun[] }[];
}) {
  const matrix = groupMatrix(repos);
  if (matrix.columns.length === 0)
    return <p className="text-sm text-muted-foreground">No results yet.</p>;
  return (
    <DataTable>
      <thead>
        <tr>
          <th>Repository</th>
          {matrix.columns.map((column) => (
            <th key={column.key}>
              {column.label}
              <small className="font-normal">
                {column.harness}
                {column.thinking ? ` · ${column.thinking}` : ""}
              </small>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {matrix.rows.map((row) => (
          <tr key={row.fullName}>
            <td className="font-mono text-xs">{row.fullName}</td>
            {matrix.columns.map((column) => {
              const cell = row.cells.get(column.key);
              return (
                <td key={column.key} className="tabular-nums">
                  {cell ? percent(cell.passRate) : "—"}
                  {cell && (
                    <small>
                      {cell.passed} / {cell.scored} passed
                      {dollars(cell.costPerTask) ? ` · ${dollars(cell.costPerTask)}` : ""}
                    </small>
                  )}
                </td>
              );
            })}
          </tr>
        ))}
        <tr className="font-semibold">
          <td>Average</td>
          {matrix.columns.map((column) => {
            const average = matrix.average.get(column.key);
            return (
              <td key={column.key} className="tabular-nums">
                {percent(average?.passRate)}
                <small className="font-normal">
                  {average?.repos ?? 0} repositories
                  {dollars(average?.costPerTask) ? ` · ${dollars(average?.costPerTask)}` : ""}
                </small>
              </td>
            );
          })}
        </tr>
        <tr>
          <td>Pooled</td>
          {matrix.columns.map((column) => {
            const pooled = matrix.pooled.get(column.key);
            return (
              <td key={column.key} className="tabular-nums">
                {percent(pooled?.passRate)}
                <small>
                  {pooled?.passed ?? 0} / {pooled?.scored ?? 0} passed
                </small>
              </td>
            );
          })}
        </tr>
      </tbody>
    </DataTable>
  );
}
