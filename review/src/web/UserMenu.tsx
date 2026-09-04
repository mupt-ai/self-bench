import React from "react";
import { Avatar, Dropdown } from "./Dropdown";
import type { SiteUser } from "./session";

/** Avatar + login in the top bar; opens a small account menu holding Sign Out. */
export function UserMenu({ user, onSignOut }: { user: SiteUser; onSignOut: () => Promise<void> }) {
  const [busy, setBusy] = React.useState(false);
  return (
    <Dropdown
      label="Account"
      className="user-menu"
      trigger={
        <>
          <Avatar login={user.login} url={user.avatarUrl} />
          <span className="dropdown-text">{user.login}</span>
        </>
      }
    >
      {() => (
        <>
          <div className="dropdown-head">
            <div className="eyebrow">Account</div>
            {user.name && <div className="dropdown-title">{user.name}</div>}
            <div className="dropdown-sub">@{user.login}</div>
          </div>
          <button
            type="button"
            role="menuitem"
            className="dropdown-item"
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
