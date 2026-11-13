import { Plus } from "lucide-react";
import React from "react";
import { formatAgo } from "../api";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { useOrgCredentials } from "../setup/SetupStatus";
import { Button, DataTable, EmptyState, Notice, PageFrame, PageHeader } from "../ui";
import { HarnessDialog } from "./HarnessDialog";
import { deleteHarness, listHarnesses, listSubagentModels, type SavedHarness } from "./harness-api";
import { harnessSummary } from "./harness-summary";

/**
 * The workspace's saved harnesses: named changes to an agent (skills, instructions, options, a
 * subagent model and its credential) that any repository's or benchmark's Run page picks, to run
 * every task again beside the baseline. They change the agent, never the tasks: a repository's
 * environments do that, and a run runs every harness in every environment.
 */
export function HarnessesPage() {
  const { org } = useOrg();
  useDocumentTitle(`Harnesses · ${org.login}`);
  const [harnesses, setHarnesses] = React.useState<SavedHarness[]>();
  const [credentials] = useOrgCredentials(org.login);
  const [models, setModels] = React.useState<{ id: string; label: string }[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  // The harness being edited, "new" for one being written, or nothing while the dialog is shut.
  const [editing, setEditing] = React.useState<SavedHarness | "new">();
  const [refresh, setRefresh] = React.useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `refresh` reloads after a change.
  React.useEffect(() => {
    let stopped = false;
    Promise.all([listHarnesses(org.login), listSubagentModels(org.login)]).then(
      ([found, subagentModels]) => {
        if (stopped) return;
        setHarnesses(found);
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

  const remove = async (harness: SavedHarness) => {
    if (!window.confirm(`Delete ${harness.name}? Runs that used it keep their results.`)) return;
    try {
      await deleteHarness(org.login, harness.id);
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
        description="Save a change to an agent once, then run any tasks with and without it."
      >
        <Button variant="primary" onClick={() => setEditing("new")}>
          <Plus aria-hidden="true" />
          New Harness
        </Button>
      </PageHeader>
      {error && <Notice className="mb-5">{error}</Notice>}
      {!harnesses ? (
        !error && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading harnesses…
          </p>
        )
      ) : harnesses.length === 0 ? (
        <EmptyState title="No Harnesses Yet">
          Add skills, extra instructions, options, or a subagent model to an agent. Then pick the
          harness on any Run page to compare it with the baseline.
        </EmptyState>
      ) : (
        <DataTable>
          <thead>
            <tr>
              <th>Harness</th>
              <th>Changes</th>
              <th className="text-right">Updated</th>
              <th className="w-36" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {harnesses.map((harness) => (
              <tr key={harness.id}>
                <td className="font-semibold">{harness.name}</td>
                <td className="text-muted-foreground">
                  {harnessSummary(harness, models).join(" · ")}
                </td>
                <td className="text-right whitespace-nowrap text-muted-foreground">
                  {[harness.createdBy, formatAgo(harness.updatedAt)].filter(Boolean).join(" · ")}
                </td>
                <td className="text-right whitespace-nowrap">
                  <Button
                    variant="ghost"
                    size="small"
                    aria-label={`Edit ${harness.name}`}
                    onClick={() => setEditing(harness)}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="small"
                    aria-label={`Delete ${harness.name}`}
                    onClick={() => void remove(harness)}
                  >
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
      {editing && (
        <HarnessDialog
          org={org.login}
          {...(editing === "new" ? {} : { harness: editing })}
          subagentModels={models}
          credentials={credentials}
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
