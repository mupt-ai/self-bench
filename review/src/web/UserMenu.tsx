import React from "react";
import type { SiteUser } from "./session";

/** Avatar + login in the top bar; opens a small account menu holding Sign out. */
export function UserMenu({ user, onSignOut }: { user: SiteUser; onSignOut: () => Promise<void> }) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const root = React.useRef<HTMLDivElement>(null);
  const trigger = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className={`user-menu ${open ? "open" : ""}`} ref={root}>
      <button
        type="button"
        className="user-trigger"
        ref={trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Avatar user={user} />
        <span className="user-login">{user.login}</span>
        <svg className="user-caret" viewBox="0 0 10 6" aria-hidden="true">
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
      {open && (
        <div className="user-panel" role="menu" aria-label="Account">
          <div className="user-head">
            <div className="eyebrow">Account</div>
            {user.name && <div className="user-name">{user.name}</div>}
            <div className="user-handle">@{user.login}</div>
          </div>
          <button
            type="button"
            role="menuitem"
            className="user-item"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void onSignOut().finally(() => setBusy(false));
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function Avatar({ user }: { user: SiteUser }) {
  if (user.avatarUrl) {
    return <img className="user-avatar" src={user.avatarUrl} alt="" width={24} height={24} />;
  }
  return (
    <span className="user-avatar user-avatar-fallback" aria-hidden="true">
      {user.login.slice(0, 1).toUpperCase()}
    </span>
  );
}
