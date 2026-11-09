import React from "react";
import { Link } from "react-router";
import { Block } from "../../components/Script";
import { sheetBody, viewerLink } from "../../components/viewer-ui";
import { formatAgo, type TaskItem } from "../api";
import { InfoTooltip } from "../primitives/tooltip";
import { Button, Notice } from "../ui";
import { StateStamp } from "./state";
import {
  endTaskVariant,
  runVariantsPath,
  type VariantComparison,
  type VariantItem,
  variantComparison,
} from "./task-variant-api";

/** One line per change: a package swapped in, or a file written into /app. */
function changeLines(variant: VariantItem): string[] {
  if (!variant.changes) return [];
  return [
    ...variant.changes.packages.map(
      (pkg) => `${pkg.name}@${pkg.spec}${pkg.directory ? ` in ${pkg.directory}` : ""}`,
    ),
    ...variant.changes.files.map(
      (file) => `${file.mode === "append" ? "Append to" : "Replace"} ${file.path}`,
    ),
  ];
}

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
    <div className={`${sheetBody} gap-4`}>
      <Block
        title="Variants"
        detail={String(variants.length)}
        right={
          accepted &&
          task.state === "accepted" && (
            <Link className={viewerLink} to={runVariantsPath(fullName, task, variants)}>
              Run Task and Variants
            </Link>
          )
        }
      >
        <ul className="divide-y divide-border">
          {variants.map((variant) => (
            <li key={variant.runId} className="grid gap-1.5 px-4 py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-sm font-medium">{variant.label}</span>
                <StateStamp state={variant.state} />
                <span className="text-xs text-muted-foreground">
                  {[variant.startedBy, formatAgo(variant.startedAt)].filter(Boolean).join(" · ")}
                </span>
                <span className="ml-auto flex gap-2">
                  {variant.state === "in_progress" ? (
                    <Button
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => void end(variant, "cancel")}
                    >
                      {busy === variant.runId ? "Stopping…" : "Stop Check"}
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => void end(variant, "delete")}
                    >
                      {busy === variant.runId ? "Deleting…" : "Delete"}
                    </Button>
                  )}
                </span>
              </div>
              {changeLines(variant).length > 0 && (
                <ul className="grid gap-0.5 font-mono text-xs text-muted-foreground">
                  {changeLines(variant).map((line) => (
                    <li key={line} className="wrap-anywhere">
                      {line}
                    </li>
                  ))}
                </ul>
              )}
              {variant.reasonSummary && variant.state !== "accepted" && (
                <p className="text-sm leading-6 text-muted-foreground wrap-anywhere">
                  {variant.reasonSummary}
                </p>
              )}
            </li>
          ))}
        </ul>
      </Block>
      {error && <Notice>{error}</Notice>}
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
    <Block
      title="Results by Variant"
      right={
        <InfoTooltip label="Each configuration's latest scored result on the task and on each variant. Variant results never count toward the repository's results." />
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="px-4 py-2 font-medium">Configuration</th>
              {columns.map((column) => (
                <th key={column.key} className="px-4 py-2 font-medium">
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((configuration) => (
              <tr key={configuration.key} className="border-t border-border">
                <td className="px-4 py-2">{configuration.name}</td>
                {columns.map((column) => {
                  const result = outcome(column, configuration.key);
                  return (
                    <td key={column.key} className="px-4 py-2">
                      {result ? (
                        <span className={result.passed ? "font-semibold" : "text-muted-foreground"}>
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
            <tr className="border-t border-border text-xs text-muted-foreground">
              <td className="px-4 py-2">Passed</td>
              {columns.map((column) => (
                <td key={column.key} className="px-4 py-2 tabular-nums">
                  {column.results ? `${column.results.passed} of ${column.results.scored}` : "—"}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </Block>
  );
}
