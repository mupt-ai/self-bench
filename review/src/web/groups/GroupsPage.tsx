import { Plus } from "lucide-react";
import React from "react";
import { Link, useNavigate } from "react-router";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { Button, DataTable, EmptyState, Notice, PageFrame, PageHeader } from "../ui";
import { fetchGroups, type RepoGroup, saveGroup } from "./api";
import { GroupForm } from "./GroupForm";

export function GroupsPage() {
  useDocumentTitle("Repository Groups");
  const { org } = useOrg();
  const navigate = useNavigate();
  const [groups, setGroups] = React.useState<RepoGroup[]>();
  const [error, setError] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  React.useEffect(() => {
    let disposed = false;
    fetchGroups(org.login).then(
      (result) => {
        if (!disposed) setGroups(result);
      },
      (cause) => {
        if (!disposed) setError(`Could not load groups: ${cause.message}`);
      },
    );
    return () => {
      disposed = true;
    };
  }, [org.login]);
  return (
    <PageFrame>
      <PageHeader
        title="Repository Groups"
        description="Run the same evaluation on several repositories and compare them."
      >
        {!creating && (
          <Button size="small" variant="primary" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Create Group
          </Button>
        )}
      </PageHeader>
      {error && <Notice className="mb-6">{error}</Notice>}
      {creating && (
        <GroupForm
          org={org.login}
          saveLabel="Create Group"
          onCancel={() => setCreating(false)}
          onSave={async (draft) => {
            const group = await saveGroup(org.login, draft);
            void navigate(`/groups/${group.id}`);
          }}
        />
      )}
      {groups?.length === 0 && !creating && (
        <EmptyState
          title="No Groups Yet"
          action={
            <Button size="small" onClick={() => setCreating(true)}>
              Create Group
            </Button>
          }
        >
          Group repositories, such as several Next.js apps, to evaluate them with the same models
          and compare each repository's results.
        </EmptyState>
      )}
      {!!groups?.length && (
        <DataTable>
          <thead>
            <tr>
              <th>Name</th>
              <th>Repositories</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <tr key={group.id}>
                <td>
                  <Link
                    className="font-semibold underline-offset-4 hover:underline"
                    to={`/groups/${group.id}`}
                  >
                    {group.name}
                  </Link>
                </td>
                <td>
                  {group.repos.length}
                  <small className="max-w-md truncate font-mono">{group.repos.join(", ")}</small>
                </td>
                <td className="text-muted-foreground">
                  {new Date(group.createdAt).toLocaleDateString()}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </PageFrame>
  );
}
