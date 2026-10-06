import type { ThinkingLevel } from "../../../../src/contracts/models";
import type { EvaluationRun, Harness } from "../evaluation/api";
import { type Configuration, configurationsOf } from "../evaluation/results-model";

/** One setting's result in one repository: what its tasks' results that count add up to. */
export interface MatrixCell {
  passed: number;
  /** Results that passed or failed. */
  scored: number;
  /** Tasks with any result, scored or not. */
  tasks: number;
  passRate?: number;
  costPerTask?: number;
  status: Configuration["status"];
}

export interface MatrixColumn {
  key: string;
  label: string;
  harness: Harness;
  thinking?: ThinkingLevel;
}

interface GroupMatrix {
  columns: MatrixColumn[];
  rows: { fullName: string; cells: Map<string, MatrixCell> }[];
  /** Each repository counts once: the mean of their pass rates and costs per task. */
  average: Map<string, { passRate?: number; costPerTask?: number; repos: number }>;
  /** Every task counts once, whichever repository it is in. */
  pooled: Map<string, { passed: number; scored: number; passRate?: number }>;
}

const mean = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;

/**
 * Repositories against settings (model, harness and reasoning, as the Results page groups
 * them), from the runs of each repository's comparison in one group evaluation.
 */
export function groupMatrix(repos: readonly { fullName: string; runs: EvaluationRun[] }[]) {
  const columns = new Map<string, MatrixColumn>();
  const rows = repos.map(({ fullName, runs }) => {
    const cells = new Map<string, MatrixCell>();
    for (const configuration of configurationsOf(runs, [])) {
      const { key, label, harness, thinking, counts, latest, passRate, costPerTask, status } =
        configuration;
      if (!columns.has(key))
        columns.set(key, { key, label, harness, ...(thinking ? { thinking } : {}) });
      cells.set(key, {
        passed: counts.passed,
        scored: counts.passed + counts.failed,
        tasks: latest.length,
        ...(passRate !== undefined ? { passRate } : {}),
        ...(costPerTask !== undefined ? { costPerTask } : {}),
        status,
      });
    }
    return { fullName, cells };
  });
  const ordered = [...columns.values()].sort(
    (a, b) =>
      a.label.localeCompare(b.label) ||
      a.harness.localeCompare(b.harness) ||
      (a.thinking ?? "").localeCompare(b.thinking ?? ""),
  );
  const average: GroupMatrix["average"] = new Map();
  const pooled: GroupMatrix["pooled"] = new Map();
  for (const { key } of ordered) {
    const cells = rows.flatMap((row) => {
      const cell = row.cells.get(key);
      return cell ? [cell] : [];
    });
    const rates = cells.flatMap((cell) => (cell.passRate !== undefined ? [cell.passRate] : []));
    const passRate = mean(rates);
    const costPerTask = mean(
      cells.flatMap((cell) => (cell.costPerTask !== undefined ? [cell.costPerTask] : [])),
    );
    average.set(key, {
      ...(passRate !== undefined ? { passRate } : {}),
      ...(costPerTask !== undefined ? { costPerTask } : {}),
      repos: rates.length,
    });
    const passed = cells.reduce((sum, cell) => sum + cell.passed, 0);
    const scored = cells.reduce((sum, cell) => sum + cell.scored, 0);
    pooled.set(key, { passed, scored, ...(scored ? { passRate: (passed / scored) * 100 } : {}) });
  }
  return { columns: ordered, rows, average, pooled } satisfies GroupMatrix;
}
