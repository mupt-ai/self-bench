import React from "react";
import { Lockup } from "../Lockup";
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

/** The signed-in shell: lockup, org switcher, account menu, and a placeholder body. */
export function HomePage({ user, orgs }: { user: SiteUser; orgs: SiteOrg[] }) {
  const { signOut } = useSession();
  const [org, setOrg] = React.useState(() => defaultOrg(orgs));
  useDocumentTitle(`${org.login} · self-bench`);
  const choose = (next: SiteOrg) => {
    rememberOrg(next.login);
    setOrg(next);
  };
  return (
    <div className="site-shell">
      <header className="site-bar">
        <div className="site-bar-left">
          <Lockup />
          <OrgSwitcher orgs={orgs} current={org} onSelect={choose} />
        </div>
        <UserMenu user={user} onSignOut={signOut} />
      </header>
      <main className="site-body">
        <p className="site-placeholder">Runs coming soon</p>
      </main>
    </div>
  );
}
