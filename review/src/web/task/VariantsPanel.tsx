import React from "react";
import { Link } from "react-router";
import { sheetBody } from "../../components/viewer-ui";
import { formatAgo, type TaskItem } from "../api";
import { InfoTooltip } from "../primitives/tooltip";
import { Button, buttonStyles, DataTable, Notice } from "../ui";
import { StateStamp } from "./state";
import {
  endTaskVariant,
  runVariantsPath,
  type VariantComparison,
  type VariantItem,
  variantComparison,
} from "./task-variant-api";

const code = "font-mono text-foreground";

/** What a variant changes, as a sentence: identifiers in mono, the rest in the body text. */
function Changes({ variant }: { variant: VariantItem }) {
  if (!variant.changes) return null;
  const parts = [
    ...variant.changes.packages.map((pkg) => (
      <span key={`p:${pkg.name}:${pkg.directory}`}>
        <span className={code}>{pkg.name}</span> at <span className={code}>{pkg.spec}</span>
        {pkg.directory && (
          <>
            {" "}
            in <span className={code}>{pkg.directory}</span>
          </>
        )}
      </span>
    )),
    ...variant.changes.files.map((file) => (
      <span key={`f:${file.path}`}>
        {file.mode === "append" ? "Appends to" : "Replaces"}{" "}
        <span className={code}>{file.path}</span>
      </span>
    )),
  ];
  return (
    <p className="text-sm leading-6 text-muted-foreground wrap-anywhere">
      {parts.map((part, index) => (
        <React.Fragment key={part.key}>
          {index > 0 && " · "}
          {part}
        </React.Fragment>
      ))}
    </p>
  );
}

const sectionTitle = "flex items-center gap-1.5 text-sm font-semibold text-foreground";

/**
 * A task's variants, listed under it rather than as tasks: each one's check, what it changes, and
 * how the task and its variants did on each configuration that ran them.
 */
export function VariantsPanel({
  org,
  fullName,
  task,
  variants,
  onChanged,
}: {
  org: string;
  fullName: string;
  task: TaskItem;
  variants: VariantItem[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [comparison, setComparison] = React.useState<VariantComparison | null>(null);
  const accepted = variants.some((variant) => variant.state === "accepted");
  const { runId, taskId } = task;

  React.useEffect(() => {
    if (!accepted) return;
    let stopped = false;
    variantComparison(org, fullName, { runId, taskId }).then(
      (found) => {
        if (!stopped) setComparison(found);
      },
      // A task outside the results (not approved yet) has no comparison to show.
      () => {
        if (!stopped) setComparison(null);
      },
    );
    return () => {
      stopped = true;
    };
  }, [org, fullName, runId, taskId, accepted]);

  if (variants.length === 0) return null;

  const end = async (variant: VariantItem, action: "cancel" | "delete") => {
    setBusy(variant.runId);
    setError(null);
    try {
      await endTaskVariant(org, fullName, { runId, taskId }, variant.runId, action);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={sheetBody}>
      <section aria-labelledby="variants-title">
        <h2 id="variants-title" className={sectionTitle}>
          Variants
          <InfoTooltip label="This task with only its environment changed. Each is checked once, never reviewed, and compared beside this task; none counts toward the repository's results." />
        </h2>
        <ul className="mt-3 divide-y divide-border border-y border-border">
          {variants.map((variant) => (
            <li key={variant.runId} className="flex items-start gap-4 py-4">
              <div className="grid min-w-0 flex-1 gap-1">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-sm font-semibold text-foreground">{variant.label}</span>
                  <StateStamp state={variant.state} />
                  <span className="text-sm text-muted-foreground">
                    {[variant.startedBy, formatAgo(variant.startedAt)].filter(Boolean).join(" · ")}
                  </span>
                </div>
                <Changes variant={variant} />
                {variant.reasonSummary && variant.state !== "accepted" && (
                  <p className="text-sm leading-6 text-muted-foreground wrap-anywhere">
                    {variant.reasonSummary}
                  </p>
                )}
              </div>
              <Button
                variant="ghost"
                size="small"
                className="-mt-1 shrink-0 text-sm text-muted-foreground hover:text-foreground"
                disabled={busy !== null}
                onClick={() =>
                  void end(variant, variant.state === "in_progress" ? "cancel" : "delete")
                }
              >
                {variant.state === "in_progress"
                  ? busy === variant.runId
                    ? "Stopping…"
                    : "Stop Check"
                  : busy === variant.runId
                    ? "Deleting…"
                    : "Delete"}
              </Button>
            </li>
          ))}
        </ul>
      </section>
      {error && <Notice>{error}</Notice>}
      {accepted && task.state === "accepted" && (
        <div>
          <Link className={buttonStyles.primary} to={runVariantsPath(fullName, task, variants)}>
            Run Task and Variants
          </Link>
        </div>
      )}
      {comparison && comparison.variants.length > 0 && (
        <VariantResultsTable comparison={comparison} />
      )}
    </div>
  );
}

/** Each configuration's latest result on the task and on each variant, side by side. */
function VariantResultsTable({ comparison }: { comparison: VariantComparison }) {
  const columns = [
    { key: "task", label: "Task", results: comparison.task },
    ...comparison.variants.map((variant) => ({
      key: variant.runId,
      label: variant.label,
      results: variant,
    })),
  ];
  const ran = new Set(
    columns.flatMap((column) => column.results?.results.map((r) => r.configuration) ?? []),
  );
  const rows = comparison.configurations.filter((configuration) => ran.has(configuration.key));
  const outcome = (column: (typeof columns)[number], configuration: string) =>
    column.results?.results.find((result) => result.configuration === configuration);
  return (
    <section aria-labelledby="variant-results-title" className="grid gap-3">
      <h2 id="variant-results-title" className={sectionTitle}>
        Results by Variant
        <InfoTooltip label="Each configuration's latest scored result on the task and on each variant." />
      </h2>
      <DataTable>
        <thead>
          <tr>
            <th>Configuration</th>
            {columns.map((column) => (
              <th key={column.key}>{column.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((configuration) => (
            <tr key={configuration.key}>
              <td>{configuration.name}</td>
              {columns.map((column) => {
                const result = outcome(column, configuration.key);
                return (
                  <td key={column.key}>
                    {result ? (
                      <span
                        className={
                          result.passed ? "font-semibold text-foreground" : "text-muted-foreground"
                        }
                      >
                        {result.passed ? "Pass" : "Fail"}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Not Run</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
          <tr>
            <td className="text-muted-foreground">Passed</td>
            {columns.map((column) => (
              <td key={column.key} className="font-mono text-muted-foreground tabular-nums">
                {column.results ? `${column.results.passed}/${column.results.scored}` : "—"}
              </td>
            ))}
          </tr>
        </tbody>
      </DataTable>
    </section>
  );
}
