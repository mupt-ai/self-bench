import { Lockup } from "../Lockup";
import { type SiteUser, useDocumentTitle, useSession } from "../session";
import { UserMenu } from "../UserMenu";

/** The signed-in shell: lockup, account menu, and a placeholder body. */
export function HomePage({ user }: { user: SiteUser }) {
  useDocumentTitle("self-bench");
  const { signOut } = useSession();
  return (
    <div className="site-shell">
      <header className="site-bar">
        <Lockup />
        <UserMenu user={user} onSignOut={signOut} />
      </header>
      <main className="site-body">
        <p className="site-placeholder">Runs coming soon</p>
      </main>
    </div>
  );
}
