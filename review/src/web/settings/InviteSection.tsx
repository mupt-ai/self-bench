import React from "react";
import { InfoTooltip } from "../primitives/tooltip";
import { Button, EmptyState, Input, Select } from "../ui";
import { type Invite, inviteMember, type MemberRole, revokeInvite, roleLabels } from "./members";
import { useAction } from "./use-action";

export function InviteSection({
  org,
  invites,
  onChanged,
}: {
  org: string;
  invites: Invite[];
  onChanged(message: string): Promise<void>;
}) {
  const [login, setLogin] = React.useState("");
  const [role, setRole] = React.useState<MemberRole>("member");
  const { busy, run, message } = useAction();
  return (
    <section aria-labelledby="invites-title">
      <span className="mb-4 flex items-center gap-1.5">
        <h2 id="invites-title" className="text-sm leading-6 font-semibold">
          Invites
        </h2>
        <InfoTooltip label="Invite anyone by GitHub username. They join the next time they sign in." />
      </span>
      <form
        className="mb-4 flex max-w-xl flex-wrap gap-2"
        onSubmit={async (event) => {
          event.preventDefault();
          const name = login.trim();
          if (await run(() => inviteMember(org, name, role))) {
            setLogin("");
            await onChanged(`${name} invited.`);
          }
        }}
      >
        <Input
          aria-label="GitHub Username"
          className="min-w-48 flex-1"
          value={login}
          required
          placeholder="GitHub Username"
          onChange={(event) => setLogin(event.target.value)}
        />
        <Select
          aria-label="Role"
          className="w-32"
          value={role}
          onChange={(event) => setRole(event.target.value as MemberRole)}
        >
          <option value="member">{roleLabels.member}</option>
          <option value="admin">{roleLabels.admin}</option>
        </Select>
        <Button type="submit" variant="primary" disabled={busy || !login.trim()}>
          {busy ? "Inviting…" : "Invite"}
        </Button>
      </form>
      {message}
      {invites.length === 0 ? (
        <EmptyState title="No Pending Invites" />
      ) : (
        <ul className="divide-y divide-border border border-border bg-card">
          {invites.map((invite) => (
            <li key={invite.id} className="flex items-center gap-3 px-4 py-3 text-sm">
              <span className="min-w-0 flex-1 font-mono">{invite.githubLogin}</span>
              <span className="text-muted-foreground">{roleLabels[invite.role]}</span>
              <Button
                size="small"
                variant="ghost"
                disabled={busy}
                aria-label={`Revoke invite for ${invite.githubLogin}`}
                onClick={async () => {
                  if (await run(() => revokeInvite(org, invite.id)))
                    await onChanged(`Invite for ${invite.githubLogin} revoked.`);
                }}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
