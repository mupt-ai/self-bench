import { Layers } from "lucide-react";
import React from "react";
import { useNavigate } from "react-router";
import { formatAgo } from "../api";
import { CardGridSkeleton } from "../LoadingSkeleton";
import { AddScopeButton, ScopeCard } from "../ScopeCard";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { Notice, PageFrame, PageHeader } from "../ui";
import { deleteGroup, type GroupList, type GroupView, groupRequest, groupsUrl } from "./api";
import { GroupDialog } from "./GroupDialog";

/**
 * Repository Groups: sets of the workspace's connected repositories, each evaluated like one
 * repository over all their approved tasks, with its own Run, Results, and Releases.
 */
export function GroupsPage() {
  const { org } = useOrg();
  const navigate = useNavigate();
  useDocumentTitle(`Repository Groups · ${org.login}`);
  const [list, setList] = React.useState<GroupList>();
  const [error, setError] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const load = React.useCallback(
    () =>
      groupRequest<GroupList>(groupsUrl(org.login)).then(
        (next) => {
          setList(next);
          setError("");
        },
        (cause: Error) => setError(cause.message),
      ),
    [org.login],
  );
  React.useEffect(() => {
    setList(undefined);
    void load();
  }, [load]);
  const remove = (group: GroupView) =>
    deleteGroup(org.login, group).then(
      (deleted) => deleted && void load(),
      (cause: Error) => setError(cause.message),
    );
  return (
    <PageFrame>
      <PageHeader
        title="Repository Groups"
        description="Evaluate several repositories together, as one dataset of all their approved tasks."
      />
      {error && <Notice className="mb-4">{error}</Notice>}
      {!list && !error && <CardGridSkeleton label="Loading Groups" />}
      {list && (
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {list.groups.map((group) => (
            <li key={group.slug}>
              <ScopeCard
                name={group.name}
                to={`/groups/${group.slug}`}
                icon={
                  <Layers className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                }
                details={[
                  group.repositories.map((member) => member.fullName).join(", "),
                  `Updated ${formatAgo(group.updatedAt)}`,
                ]}
                stats={[
                  { label: "Repositories", value: group.repositories.length },
                  { label: "Tasks", value: group.tasks },
                  {
                    label: "Disconnected",
                    value: group.repositories.filter((member) => !member.connected).length,
                    attention: group.repositories.some((member) => !member.connected),
                  },
                ]}
                removeLabel="Delete"
                onRemove={() => remove(group)}
              />
            </li>
          ))}
          <li>
            <AddScopeButton label="New Group" onClick={() => setCreating(true)} />
          </li>
        </ul>
      )}
      {creating && list && (
        <GroupDialog
          org={org.login}
          repositories={list.repositories}
          onClose={() => setCreating(false)}
          onSaved={(group) => navigate(`/groups/${group.slug}`)}
        />
      )}
    </PageFrame>
  );
}
