import React from "react";
import { Lockup } from "../Lockup";
import { NewRunSheet } from "../NewRunSheet";
import { OrgSwitcher } from "../OrgSwitcher";
import {
  defaultOrg,
  rememberOrg,
  type SiteOrg,
  type SiteUser,
  useDocumentTitle,
  useSession,
} from "../session";
import { UserMenu } from "../UserMenu";

/** The signed-in shell: lockup, org switcher, account menu, and the org's runs. */
export function HomePage({ user, orgs }: { user: SiteUser; orgs: SiteOrg[] }) {
  const { signOut } = useSession();
  const [org, setOrg] = React.useState(() => defaultOrg(orgs));
  const [creating, setCreating] = React.useState(false);
  useDocumentTitle(`${org.login} · self-bench`);
  const choose = (next: SiteOrg) => {
    rememberOrg(next.login);
    setOrg(next);
    setCreating(false);
  };
  const closeSheet = React.useCallback(() => setCreating(false), []);
  return (
    <div className="site-shell">
      <header className="site-bar">
        <div className="site-bar-left">
          <Lockup />
          <OrgSwitcher orgs={orgs} current={org} onSelect={choose} />
        </div>
        <UserMenu user={user} onSignOut={signOut} />
      </header>
      <main className="site-main">
        <div className="page-head">
          <div>
            <div className="eyebrow">Runs</div>
            <h1>Benchmark runs</h1>
          </div>
          <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
            New run
          </button>
        </div>
        <div className="empty-state">
          <p>No runs yet. Start one from a repository in {org.login}.</p>
        </div>
      </main>
      {creating && <NewRunSheet org={org} onClose={closeSheet} />}
    </div>
  );
}
