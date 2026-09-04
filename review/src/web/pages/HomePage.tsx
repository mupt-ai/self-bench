import React from "react";
import { Navigate, useParams } from "react-router";
import { Lockup } from "../Lockup";
import { OrgSwitcher } from "../OrgSwitcher";
import {
  defaultOrg,
  findOrg,
  rememberOrg,
  type SiteOrg,
  type SiteUser,
  useDocumentTitle,
  useSession,
} from "../session";
import { UserMenu } from "../UserMenu";

/** Bare "/" opens the remembered org, else the personal account (the store always records one). */
export function OrgRedirect({ orgs }: { orgs: SiteOrg[] }) {
  return <Navigate to={`/${encodeURIComponent(defaultOrg(orgs).login)}`} replace />;
}

/** The signed-in shell for one org: lockup, org switcher, account menu, and a placeholder body. */
export function HomePage({ user, orgs }: { user: SiteUser; orgs: SiteOrg[] }) {
  const { org: orgParam } = useParams();
  const org = findOrg(orgs, orgParam);
  useDocumentTitle(org ? `${org.login} · self-bench` : "self-bench");
  React.useEffect(() => {
    if (org) rememberOrg(org.login);
  }, [org]);
  if (!org) return <OrgRedirect orgs={orgs} />;
  return (
    <Shell user={user} orgs={orgs} org={org}>
      <p className="site-placeholder">Runs coming soon</p>
    </Shell>
  );
}

function Shell({
  user,
  orgs,
  org,
  children,
}: {
  user: SiteUser;
  orgs: SiteOrg[];
  org: SiteOrg;
  children: React.ReactNode;
}) {
  const { signOut } = useSession();
  return (
    <div className="site-shell">
      <header className="site-bar">
        <div className="site-bar-left">
          <Lockup />
          <OrgSwitcher orgs={orgs} current={org} />
        </div>
        <UserMenu user={user} onSignOut={signOut} />
      </header>
      <main className="site-body">{children}</main>
    </div>
  );
}
