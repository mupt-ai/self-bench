import React from "react";
import { Outlet, useLocation, useNavigate, useOutletContext } from "react-router";
import { Lockup } from "./Lockup";
import { OrgSwitcher } from "./OrgSwitcher";
import { defaultOrg, rememberOrg, type SiteOrg, type SiteUser, useSession } from "./session";
import { UserMenu } from "./UserMenu";

export interface OrgContext {
  org: SiteOrg;
  orgs: SiteOrg[];
}

/** The org the page is showing, chosen in the top bar and remembered in this browser. */
export function useOrg(): OrgContext {
  return useOutletContext<OrgContext>();
}

/** Top bar plus the current org; every signed-in page renders inside it. */
export function SiteLayout({ user, orgs }: { user: SiteUser; orgs: SiteOrg[] }) {
  const { signOut } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [org, setOrg] = React.useState(() => defaultOrg(orgs));
  const choose = (next: SiteOrg) => {
    rememberOrg(next.login);
    setOrg(next);
    if (location.pathname !== "/") void navigate("/");
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
      <Outlet context={{ org, orgs } satisfies OrgContext} key={org.login} />
    </div>
  );
}

export function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

/** A broken chain link. */
export function UnlinkIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M6.5 9.5 3.7 12.3a2 2 0 0 0 2.8 2.8l1.6-1.6M9.5 6.5l2.8-2.8a2 2 0 0 0-2.8-2.8L7.9 2.5" />
      <path d="M2 2l2 2M12 12l2 2M1.5 6h2M6 1.5v2M14.5 10h-2M10 14.5v-2" />
    </svg>
  );
}
