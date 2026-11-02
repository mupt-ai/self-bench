import React from "react";
import { useNavigate, useParams } from "react-router";
import { ListSkeleton } from "../LoadingSkeleton";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { Button, Notice, PageContent, PageHeader } from "../ui";
import { type GroupList, type GroupView, groupRequest, groupsUrl } from "./api";
import { GroupDialog } from "./GroupDialog";

/** A group's settings: its name, address, and members, and deleting it. */
export function GroupSettingsPage() {
  const { org } = useOrg();
  const { slug = "" } = useParams();
  const navigate = useNavigate();
  const [list, setList] = React.useState<GroupList>();
  const [error, setError] = React.useState("");
  const [editing, setEditing] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    groupRequest<GroupList>(groupsUrl(org.login)).then(setList, (cause: Error) =>
      setError(cause.message),
    );
  }, [org.login]);
  const group: GroupView | undefined = list?.groups.find((each) => each.slug === slug);
  useDocumentTitle(`Settings · ${group?.name ?? slug} · SelfBench`);
  const remove = async () => {
    if (!group || !window.confirm(`Delete ${group.name}? Its runs stop showing here.`)) return;
    setBusy(true);
    try {
      await groupRequest(groupsUrl(org.login, slug), { method: "DELETE" });
      navigate("/groups");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete the group");
      setBusy(false);
    }
  };
  return (
    <PageContent>
      <PageHeader title="Settings" description="The group's name, address, and repositories." />
      {error && <Notice className="mb-4">{error}</Notice>}
      {!list && !error && <ListSkeleton label="Loading Group" />}
      {group && list && (
        <div className="flex flex-col gap-6">
          <section className="panel flex flex-wrap items-start justify-between gap-4 p-5">
            <div className="min-w-0">
              <h2 className="font-semibold">{group.name}</h2>
              <p className="mt-1 font-mono text-sm text-muted-foreground">/groups/{group.slug}</p>
              {group.description && (
                <p className="mt-2 text-sm text-muted-foreground">{group.description}</p>
              )}
              <p className="mt-3 font-mono text-sm wrap-anywhere">
                {group.repositories.map((member) => member.fullName).join(", ")}
              </p>
            </div>
            <Button onClick={() => setEditing(true)}>Edit Group</Button>
          </section>
          <section className="panel flex flex-wrap items-center justify-between gap-4 p-5">
            <div className="min-w-0">
              <h2 className="font-semibold">Delete Group</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Its runs stop showing here. Its releases stay public until withdrawn.
              </p>
            </div>
            <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
              {busy ? "Deleting…" : "Delete Group"}
            </Button>
          </section>
        </div>
      )}
      {editing && group && list && (
        <GroupDialog
          org={org.login}
          group={group}
          repositories={list.repositories}
          onClose={() => setEditing(false)}
          onSaved={(saved) => {
            setEditing(false);
            if (saved.slug !== slug) navigate(`/groups/${saved.slug}/settings`, { replace: true });
            setList(
              (current) =>
                current && {
                  ...current,
                  groups: current.groups.map((each) => (each.slug === slug ? saved : each)),
                },
            );
          }}
        />
      )}
    </PageContent>
  );
}
