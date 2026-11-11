import { Building2 } from "lucide-react";
import React from "react";
import { Avatar } from "../Dropdown";
import { InfoTooltip } from "../primitives/tooltip";
import type { SiteOrg } from "../session";
import { Button, Input, SectionHeader, Select } from "../ui";
import {
  connectGitHub,
  type GitHubConnection,
  type Member,
  type MemberRole,
  removeMember,
  renameWorkspace,
  roleLabels,
  setMemberRole,
} from "./members";
import { useAction } from "./use-action";

const tableHead =
  "bg-muted/50 text-[10px] tracking-wider text-muted-foreground uppercase [&_th]:px-4 [&_th]:py-3 [&_th]:font-medium";

export function WorkspaceNameForm({ org, onSaved }: { org: SiteOrg; onSaved(): void }) {
  const [name, setName] = React.useState(org.name ?? "");
  const { busy, run, message } = useAction();
  return (
    <section aria-labelledby="workspace-name-title">
      <span className="mb-4 flex items-center gap-1.5">
        <h2 id="workspace-name-title" className="text-sm leading-6 font-semibold">
          Display Name
        </h2>
        <InfoTooltip label={`The workspace's address, ${org.login}, stays as it is.`} />
      </span>
      <form
        className="flex max-w-md gap-2"
        onSubmit={async (event) => {
          event.preventDefault();
          if (await run(() => renameWorkspace(org.login, name.trim()))) onSaved();
        }}
      >
        <Input
          aria-label="Display Name"
          value={name}
          maxLength={80}
          placeholder={org.login}
          onChange={(event) => setName(event.target.value)}
        />
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </form>
      {message}
    </section>
  );
}

export function GitHubSection({
  org,
  connections,
  canManage,
  onConnected,
}: {
  org: string;
  connections: GitHubConnection[];
  canManage: boolean;
  onConnected(login: string): void;
}) {
  const [login, setLogin] = React.useState("");
  const { busy, run, message } = useAction();
  return (
    <section aria-labelledby="github-orgs-title">
      <span className="mb-4 flex items-center gap-1.5">
        <h2 id="github-orgs-title" className="text-sm leading-6 font-semibold">
          GitHub Organizations
        </h2>
        <InfoTooltip label="Members of a connected GitHub organization join this workspace when they sign in, and leave it when they leave the organization. Its private repositories can be connected here." />
      </span>
      {connections.length ? (
        <ul className="mb-4 divide-y divide-border border border-border bg-card">
          {connections.map((connection) => (
            <li key={connection.githubId} className="flex items-center gap-3 px-4 py-3 text-sm">
              <Avatar login={connection.login} size={20} />
              <span className="font-mono">{connection.login}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-4 text-sm text-muted-foreground">No GitHub organizations connected.</p>
      )}
      {canManage && (
        <form
          className="flex max-w-md gap-2"
          onSubmit={async (event) => {
            event.preventDefault();
            const name = login.trim();
            if (await run(() => connectGitHub(org, name))) {
              setLogin("");
              onConnected(name);
            }
          }}
        >
          <Input
            aria-label="GitHub Organization"
            value={login}
            required
            placeholder="GitHub Organization"
            onChange={(event) => setLogin(event.target.value)}
          />
          <span className="flex items-center gap-1.5">
            <Button type="submit" disabled={busy || !login.trim()}>
              {busy ? "Connecting…" : "Connect"}
            </Button>
            <InfoTooltip label="Moves the organization here from the workspace it is in now. You must be an admin there. A workspace left with no GitHub organization keeps its members." />
          </span>
        </form>
      )}
      {message}
    </section>
  );
}

export function MemberTable({
  org,
  members,
  canManage,
  onChanged,
}: {
  org: string;
  members: Member[] | undefined;
  canManage: boolean;
  onChanged(message: string): Promise<void>;
}) {
  const { busy, run, message } = useAction();
  return (
    <section aria-labelledby="members-title">
      <SectionHeader title={<span id="members-title">People</span>} />
      {message}
      {!members ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="overflow-x-auto border border-border bg-card">
          <table className="w-full min-w-[560px] border-collapse text-left text-sm">
            <thead className={tableHead}>
              <tr>
                <th>Member</th>
                <th>Role</th>
                <th>Joined Through</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {members.map((member) => (
                <tr key={member.login}>
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-2.5">
                      <Avatar login={member.login} url={member.avatarUrl} size={24} />
                      <span className="min-w-0">
                        <span className="block font-mono">{member.login}</span>
                        {member.name && (
                          <span className="block text-xs text-muted-foreground">{member.name}</span>
                        )}
                      </span>
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {canManage ? (
                      <Select
                        aria-label={`Role for ${member.login}`}
                        value={member.role}
                        disabled={busy}
                        onChange={async (event) => {
                          const role = event.target.value as MemberRole;
                          if (await run(() => setMemberRole(org, member.login, role)))
                            await onChanged(`${member.login} is now ${roleLabels[role]}.`);
                        }}
                      >
                        <option value="admin">{roleLabels.admin}</option>
                        <option value="member">{roleLabels.member}</option>
                      </Select>
                    ) : (
                      roleLabels[member.role]
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {member.source === "github" ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Building2 className="size-3.5" aria-hidden="true" />
                        GitHub
                      </span>
                    ) : (
                      "Invite"
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {canManage && member.source === "invite" && (
                      <Button
                        size="small"
                        variant="ghost"
                        disabled={busy}
                        aria-label={`Remove ${member.login}`}
                        className="text-destructive hover:bg-destructive/[0.06] hover:text-destructive"
                        onClick={async () => {
                          if (await run(() => removeMember(org, member.login)))
                            await onChanged(`${member.login} removed.`);
                        }}
                      >
                        Remove
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
