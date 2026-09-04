import React from "react";
import { Lockup } from "../Lockup";
import { type SiteUser, useDocumentTitle, useSession } from "../session";

/** The signed-in shell: lockup, who is signed in, sign out, and a placeholder body. */
export function HomePage({ user }: { user: SiteUser }) {
  useDocumentTitle("self-bench");
  const { signOut } = useSession();
  const [busy, setBusy] = React.useState(false);
  return (
    <div className="site-shell">
      <header className="site-bar">
        <Lockup />
        <div className="site-user">
          <span className="login">{user.login}</span>
          <button
            type="button"
            className="btn-ghost"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void signOut().finally(() => setBusy(false));
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      <main className="site-body">
        <p className="site-placeholder">Runs coming soon</p>
      </main>
    </div>
  );
}
