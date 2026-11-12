import React from "react";
import { useOrg } from "../SiteLayout";
import { type SiteOrg, useDocumentTitle } from "../session";
import { Button, Notice, PageFrame, PageHeader } from "../ui";
import { InviteSection } from "./InviteSection";
import { GitHubSection, MemberTable, WorkspaceNameForm } from "./MemberSections";
import { fetchInvites, fetchMembers, type Invite, type Members } from "./members";

export function MembersPage() {
  const { org } = useOrg();
  return <MembersContent key={org.login} org={org} />;
}

/** A workspace's people: its members, invitations, and the GitHub organizations it syncs from. */
function MembersContent({ org }: { org: SiteOrg }) {
  useDocumentTitle(`Members · ${org.login}`);
  const [data, setData] = React.useState<Members>();
  const [invites, setInvites] = React.useState<Invite[]>([]);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const refresh = React.useCallback(async () => {
    try {
      const members = await fetchMembers(org.login);
      setData(members);
      setInvites(members.canManage && org.kind === "org" ? await fetchInvites(org.login) : []);
      setError("");
    } catch (cause) {
      setError(`Could not load members: ${cause instanceof Error ? cause.message : cause}`);
    }
  }, [org.login, org.kind]);
  React.useEffect(() => {
    void refresh();
  }, [refresh]);
  // Each change reports its own failure inline; a success refreshes and says what happened.
  const changed = async (message: string) => {
    setNotice(message);
    await refresh();
  };
  const personal = org.kind === "user";
  const canManage = data?.canManage ?? false;
  return (
    <PageFrame>
      <PageHeader
        title="Members"
        description={
          personal
            ? "Your personal workspace. Create a shared workspace to work with others."
            : "Who can work in this workspace, and the GitHub organizations it brings members from."
        }
      />
      {error && (
        <Notice className="mb-6">
          <p>{error}</p>
          <Button size="small" onClick={() => void refresh()}>
            Reload
          </Button>
        </Notice>
      )}
      {notice && (
        <Notice tone="success" className="mb-6">
          {notice}
        </Notice>
      )}
      <div className="grid gap-10">
        {!personal && canManage && (
          <WorkspaceNameForm org={org} onSaved={() => changed("Display name saved.")} />
        )}
        {!personal && data && (
          <GitHubSection
            org={org.login}
            connections={data.github}
            canManage={canManage}
            onConnected={(login) =>
              changed(`${login} connected. Its members join when they next sign in.`)
            }
          />
        )}
        <MemberTable
          org={org.login}
          members={data?.members}
          canManage={canManage && !personal}
          onChanged={changed}
        />
        {!personal && canManage && (
          <InviteSection org={org.login} invites={invites} onChanged={changed} />
        )}
      </div>
    </PageFrame>
  );
}
