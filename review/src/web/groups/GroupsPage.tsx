import { ArrowUpRight } from "lucide-react";
import React from "react";
import { formatAgo } from "../api";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "../Dialog";
import { GhostGroup } from "../ghosts";
import { ListSkeleton } from "../LoadingSkeleton";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { Button, buttonStyles, DataTable, EmptyState, Notice, PageFrame, PageHeader } from "../ui";
import { type GroupList, type GroupSummary, groupRequest, groupsUrl } from "./api";
import { GroupDialog } from "./GroupDialog";

/**
 * Repository Groups: the workspace's named sets of released repositories, each published on
 * selfbench.dev as one leaderboard pooled from the members' current releases.
 */
export function GroupsPage() {
  const { org } = useOrg();
  useDocumentTitle("Repository Groups");
  const [list, setList] = React.useState<GroupList>();
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [editing, setEditing] = React.useState<GroupSummary | "new">();
  const [deleting, setDeleting] = React.useState<GroupSummary>();
  // Only the latest request may set state: switching workspaces reuses the page.
  const latest = React.useRef(0);
  const load = React.useCallback(async () => {
    latest.current += 1;
    const request = latest.current;
    try {
      const next = await groupRequest<GroupList>(groupsUrl(org.login));
      if (request !== latest.current) return;
      setList(next);
      setError("");
    } catch (cause) {
      if (request !== latest.current) return;
      setError(cause instanceof Error ? cause.message : "Could not load groups");
    }
  }, [org.login]);
  React.useEffect(() => {
    setList(undefined);
    void load();
  }, [load]);

  return (
    <PageFrame>
      <PageHeader
        title="Repository Groups"
        description="One leaderboard on selfbench.dev across several released repositories."
      >
        {/* An empty page offers it in its empty state instead. */}
        {list && list.groups.length > 0 && (
          <Button variant="primary" onClick={() => setEditing("new")}>
            New Group
          </Button>
        )}
      </PageHeader>
      {notice && (
        <Notice tone="success" className="mb-4">
          {notice}
        </Notice>
      )}
      {error && <Notice className="mb-4">{error}</Notice>}
      {!list ? (
        !error && <ListSkeleton label="Loading Groups" />
      ) : list.groups.length === 0 ? (
        <EmptyState
          title="No Groups Yet"
          visual={<GhostGroup />}
          action={
            <Button variant="primary" onClick={() => setEditing("new")}>
              New Group
            </Button>
          }
        >
          Group repositories you have released, such as a language's web frameworks, to publish one
          leaderboard scored over all their tasks.
        </EmptyState>
      ) : (
        <DataTable>
          <thead>
            <tr>
              <th>Group</th>
              <th>Repositories</th>
              <th>Updated</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.groups.map((group) => {
              const unreleased = group.repositories.filter((repository) => !repository.released);
              return (
                <tr key={group.id}>
                  <td>
                    <span className="font-medium">{group.name}</span>
                    <small className="font-mono">
                      /groups/{org.login}/{group.slug}
                    </small>
                  </td>
                  <td>
                    <span className="font-mono">
                      {group.repositories.map((repository) => repository.fullName).join(", ")}
                    </span>
                    {unreleased.length > 0 && (
                      <small>
                        Not shown until released again:{" "}
                        {unreleased.map((repository) => repository.fullName).join(", ")}
                      </small>
                    )}
                  </td>
                  <td>
                    {formatAgo(group.updatedAt)}
                    <small>by {group.updatedBy}</small>
                  </td>
                  <td className="text-right whitespace-nowrap">
                    {group.publicUrl && (
                      <a
                        className={buttonStyles.ghost}
                        href={group.publicUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        View Public Page
                        <ArrowUpRight aria-hidden="true" />
                      </a>
                    )}
                    <Button size="small" variant="ghost" onClick={() => setEditing(group)}>
                      Edit
                    </Button>
                    <Button size="small" variant="ghost" onClick={() => setDeleting(group)}>
                      Delete
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      )}
      {editing && list && (
        <GroupDialog
          org={org.login}
          group={editing === "new" ? undefined : editing}
          candidates={list.candidates}
          site={list.resultsSiteUrl}
          onClose={() => setEditing(undefined)}
          onSaved={(saved) => {
            setEditing(undefined);
            setNotice(
              editing === "new"
                ? `Released ${saved.name}. Its page is public within a minute.`
                : `Saved ${saved.name}.`,
            );
            void load();
          }}
        />
      )}
      {deleting && (
        <DeleteDialog
          group={deleting}
          onClose={() => setDeleting(undefined)}
          onDelete={async () => {
            await groupRequest(groupsUrl(org.login, deleting.id), { method: "DELETE" });
            setDeleting(undefined);
            setNotice(`Deleted ${deleting.name}. Its page is gone within a minute.`);
            await load();
          }}
        />
      )}
    </PageFrame>
  );
}

function DeleteDialog({
  group,
  onDelete,
  onClose,
}: {
  group: GroupSummary;
  onDelete(): Promise<void>;
  onClose(): void;
}) {
  const cancel = React.useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  return (
    <Dialog
      initialFocus={cancel}
      onDismiss={onClose}
      busy={busy}
      size="small"
      aria-labelledby="delete-group-title"
      aria-describedby="delete-group-description"
    >
      <DialogHeader
        title="Delete Group"
        titleId="delete-group-title"
        onClose={onClose}
        busy={busy}
      />
      <DialogBody>
        <p id="delete-group-description" className="text-sm leading-6 text-muted-foreground">
          {group.name}'s page leaves selfbench.dev within a minute. Each repository's own release
          stays public.
        </p>
        {error && <Notice>{error}</Notice>}
      </DialogBody>
      <DialogFooter>
        <Button ref={cancel} disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onDelete();
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "Could not delete");
              setBusy(false);
            }
          }}
        >
          {busy ? "Deleting…" : "Delete"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
