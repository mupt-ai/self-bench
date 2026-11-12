import { Pencil, Plus, Trash2 } from "lucide-react";
import React from "react";
import { formatAgo } from "../api";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { Button, DataTable, EmptyState, Notice, PageFrame, PageHeader } from "../ui";
import { ConditionDialog } from "./ConditionDialog";
import {
  deleteCondition,
  listConditions,
  listSubagentModels,
  type SavedCondition,
} from "./condition-api";
import { conditionSummary } from "./condition-summary";

/**
 * The workspace's saved conditions: named harness changes (skills, instructions, harness options,
 * a subagent model) that any repository's or benchmark's Run page picks, to run every task again
 * beside the baseline. They change the harness, never the tasks: a repository's environments do
 * that, and a run pairs the two.
 */
export function ConditionsPage() {
  const { org } = useOrg();
  useDocumentTitle(`Harnesses · ${org.login}`);
  const [conditions, setConditions] = React.useState<SavedCondition[]>();
  const [models, setModels] = React.useState<{ id: string; label: string }[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  // The condition being edited, "new" for one being written, or nothing while the dialog is shut.
  const [editing, setEditing] = React.useState<SavedCondition | "new">();
  const [refresh, setRefresh] = React.useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `refresh` reloads after a change.
  React.useEffect(() => {
    let stopped = false;
    Promise.all([listConditions(org.login), listSubagentModels(org.login)]).then(
      ([found, subagentModels]) => {
        if (stopped) return;
        setConditions(found);
        setModels(subagentModels);
        setError(null);
      },
      (cause) => {
        if (!stopped) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      stopped = true;
    };
  }, [org.login, refresh]);

  const remove = async (condition: SavedCondition) => {
    if (!window.confirm(`Delete ${condition.name}? Runs that used it keep their results.`)) return;
    try {
      await deleteCondition(org.login, condition.id);
      setRefresh((count) => count + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <PageFrame>
      <PageHeader
        className="mb-6"
        title="Harnesses"
        description="Save a change to a harness once, then run any tasks with and without it."
      >
        <Button variant="primary" onClick={() => setEditing("new")}>
          <Plus aria-hidden="true" />
          New Harness
        </Button>
      </PageHeader>
      {error && <Notice className="mb-5">{error}</Notice>}
      {!conditions ? (
        !error && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading harnesses…
          </p>
        )
      ) : conditions.length === 0 ? (
        <EmptyState title="No Harnesses Yet">
          Add skills, extra instructions, harness options, or a subagent model. Then pick the
          condition on any Run page to compare it with the baseline.
        </EmptyState>
      ) : (
        <DataTable>
          <thead>
            <tr>
              <th>Harness</th>
              <th>Changes</th>
              <th className="text-right">Updated</th>
              <th className="w-24" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {conditions.map((condition) => (
              <tr key={condition.id}>
                <td className="font-semibold">{condition.name}</td>
                <td className="text-muted-foreground">
                  {conditionSummary(condition, models).join(" · ")}
                </td>
                <td className="text-right whitespace-nowrap text-muted-foreground">
                  {[condition.createdBy, formatAgo(condition.updatedAt)]
                    .filter(Boolean)
                    .join(" · ")}
                </td>
                <td className="text-right whitespace-nowrap">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Edit ${condition.name}`}
                    onClick={() => setEditing(condition)}
                  >
                    <Pencil className="size-4" aria-hidden="true" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${condition.name}`}
                    onClick={() => void remove(condition)}
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
      {editing && (
        <ConditionDialog
          org={org.login}
          {...(editing === "new" ? {} : { condition: editing })}
          subagentModels={models}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            setRefresh((count) => count + 1);
          }}
        />
      )}
    </PageFrame>
  );
}
