import { Pencil, Play, Trash2 } from "lucide-react";
import React from "react";
import { Link, useNavigate, useParams } from "react-router";
import { requestJson } from "../api";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "../Dialog";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import {
  Breadcrumbs,
  Button,
  buttonStyles,
  DataTable,
  EmptyState,
  Notice,
  PageFrame,
  PageHeader,
  SectionHeader,
} from "../ui";
import { deleteGroup, type GroupDetail, groupsUrl, saveGroup } from "./api";
import { GroupForm } from "./GroupForm";
import { settingsLabel } from "./settings-label";

export function GroupPage() {
  const { org } = useOrg();
  const { groupId = "" } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = React.useState<GroupDetail>();
  const [error, setError] = React.useState("");
  const [editing, setEditing] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  useDocumentTitle(detail ? `${detail.group.name} · Groups` : "Repository Group");
  const load = React.useCallback(
    () => requestJson<GroupDetail>(groupsUrl(org.login, groupId)),
    [org.login, groupId],
  );
  React.useEffect(() => {
    let disposed = false;
    load().then(
      (result) => {
        if (!disposed) setDetail(result);
      },
      (cause) => {
        if (!disposed) setError(`Could not load the group: ${cause.message}`);
      },
    );
    return () => {
      disposed = true;
    };
  }, [load]);
  const group = detail?.group;
  const approved = group?.repos.reduce((sum, repo) => sum + repo.approvedTasks, 0) ?? 0;
  return (
    <PageFrame>
      <Breadcrumbs
        items={[{ label: "Repository Groups", to: "/groups" }, { label: group?.name ?? "…" }]}
      />
      <PageHeader
        title={group?.name ?? "Repository Group"}
        description="Each evaluation runs the same models on every approved task of each repository."
      >
        {group && !editing && (
          <>
            <Button size="small" onClick={() => setEditing(true)}>
              <Pencil className="size-4" aria-hidden="true" />
              Edit Group
            </Button>
            <Button size="small" onClick={() => setDeleting(true)}>
              <Trash2 className="size-4" aria-hidden="true" />
              Delete Group
            </Button>
            {approved > 0 && (
              <Link className={buttonStyles.primary} to={`/groups/${groupId}/run`}>
                <Play aria-hidden="true" />
                Run Evaluation
              </Link>
            )}
          </>
        )}
      </PageHeader>
      {error && <Notice className="mb-6">{error}</Notice>}
      {group && editing && (
        <GroupForm
          org={org.login}
          initial={{ name: group.name, repos: group.repos.map((repo) => repo.fullName) }}
          saveLabel="Save Group"
          onCancel={() => setEditing(false)}
          onSave={async (draft) => {
            await saveGroup(org.login, draft, groupId);
            setDetail(await load());
            setEditing(false);
          }}
        />
      )}
      {group && (
        <section className="mb-8">
          <SectionHeader title="Repositories" description={`${approved} approved tasks in all.`} />
          {group.repos.length === 0 ? (
            <EmptyState title="No Repositories">Edit the group to add repositories.</EmptyState>
          ) : (
            <DataTable>
              <thead>
                <tr>
                  <th>Repository</th>
                  <th>Approved Tasks</th>
                </tr>
              </thead>
              <tbody>
                {group.repos.map((repo) => (
                  <tr key={repo.fullName}>
                    <td>
                      <Link
                        className="font-mono text-xs hover:underline"
                        to={`/repos/${repo.fullName}`}
                      >
                        {repo.fullName}
                      </Link>
                    </td>
                    <td className="tabular-nums">
                      {repo.approvedTasks}
                      {repo.approvedTasks === 0 && (
                        <small>Left out of evaluations until a task is approved.</small>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </section>
      )}
      {detail && (
        <section>
          <SectionHeader title="Evaluations" />
          {detail.evaluations.length === 0 ? (
            <EmptyState title="No Evaluations Yet">
              Run an evaluation to compare these repositories.
            </EmptyState>
          ) : (
            <DataTable>
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Models</th>
                  <th>Repositories</th>
                </tr>
              </thead>
              <tbody>
                {detail.evaluations.map((evaluation) => (
                  <tr key={evaluation.id}>
                    <td>
                      <Link
                        className="font-semibold underline-offset-4 hover:underline"
                        to={`/groups/${groupId}/evaluations/${evaluation.id}`}
                      >
                        {new Date(evaluation.createdAt).toLocaleString()}
                      </Link>
                      <small>by {evaluation.createdBy}</small>
                    </td>
                    <td>{settingsLabel(evaluation.settings)}</td>
                    <td className="tabular-nums">{evaluation.repos}</td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </section>
      )}
      {deleting && group && (
        <DeleteGroupDialog
          name={group.name}
          onClose={() => setDeleting(false)}
          onDelete={async () => {
            await deleteGroup(org.login, groupId);
            void navigate("/groups");
          }}
        />
      )}
    </PageFrame>
  );
}

function DeleteGroupDialog({
  name,
  onDelete,
  onClose,
}: {
  name: string;
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
    >
      <DialogHeader
        title="Delete Group"
        titleId="delete-group-title"
        onClose={onClose}
        busy={busy}
      />
      <DialogBody>
        <p className="text-sm leading-6 text-muted-foreground">
          Delete <strong className="text-foreground">{name}</strong>? Its repositories stay
          connected, and each repository keeps the comparisons its evaluations ran.
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
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
              setError(cause instanceof Error ? cause.message : "Could not delete the group");
              setBusy(false);
            }
          }}
        >
          Delete Group
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
