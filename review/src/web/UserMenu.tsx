import React from "react";
import { Avatar, Dropdown } from "./Dropdown";
import type { SiteUser } from "./session";

/** Account menu anchored at the right end of the site header. */
export function UserMenu({ user, onSignOut }: { user: SiteUser; onSignOut: () => Promise<void> }) {
  const [busy, setBusy] = React.useState(false);
  return (
    <Dropdown
      label="Account"
      className="user-menu"
      trigger={
        <>
          <Avatar login={user.login} url={user.avatarUrl} />
          <span className="hidden max-w-32 truncate sm:block">{user.login}</span>
        </>
      }
    >
      {() => (
        <>
          <div className="border-b border-line px-3.5 py-3">
            <div className="font-mono text-sm font-medium tracking-[0.14em] text-mint uppercase">
              Account
            </div>
            {user.name && (
              <div className="mt-1.5 font-sans text-sm leading-snug font-semibold text-ink">
                {user.name}
              </div>
            )}
            <div className="font-mono text-sm text-muted">@{user.login}</div>
          </div>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left font-mono text-sm font-medium text-ink hover:bg-surface-3 hover:text-mint-bright disabled:cursor-default disabled:opacity-50"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void onSignOut().finally(() => setBusy(false));
            }}
          >
            Sign Out
          </button>
        </>
      )}
    </Dropdown>
  );
}
