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
          <span className="hidden max-w-32 truncate text-sm font-medium sm:block">
            {user.login}
          </span>
        </>
      }
    >
      {() => (
        <>
          <div className="-mx-1 -mt-1 mb-1 border-b border-border px-3 py-2.5">
            <div className="text-xs text-faint">Account</div>
            {user.name && (
              <div className="mt-1 text-sm leading-snug font-medium text-foreground">
                {user.name}
              </div>
            )}
            <div className="text-[13px] text-muted-foreground">@{user.login}</div>
          </div>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-foreground/10 focus-visible:bg-foreground/10 focus-visible:outline-none disabled:cursor-default disabled:opacity-50"
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
