import React from "react";
import { Outlet, useLocation, useNavigate, useOutletContext } from "react-router";
import { Lockup } from "./Lockup";
import { pageContainer, pageGutter } from "./layout";
import { cn } from "./primitives/cn";
import { MobileSidebar, SiteSidebar } from "./SiteSidebar";
import { defaultOrg, rememberOrg, type SiteOrg, type SiteUser, useSession } from "./session";
import { UserMenu } from "./UserMenu";
import { Button } from "./ui";

export interface OrgContext {
  org: SiteOrg;
  orgs: SiteOrg[];
}

/** The org the page is showing, chosen in the sidebar and remembered in this browser. */
export function useOrg(): OrgContext {
  return useOutletContext<OrgContext>();
}

/** Navigation plus the current org; every signed-in page renders inside it. */
export function SiteLayout({ user, orgs }: { user: SiteUser; orgs: SiteOrg[] }) {
  const { signOut } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [org, setOrg] = React.useState(() => defaultOrg(orgs));
  const [menuOpen, setMenuOpen] = React.useState(false);
  React.useEffect(() => {
    const media = window.matchMedia("(min-width: 1024px)");
    const changed = () => {
      if (media.matches) setMenuOpen(false);
    };
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  const choose = (next: SiteOrg) => {
    rememberOrg(next.login);
    setOrg(next);
    setMenuOpen(false);
    if (location.pathname !== "/" && location.pathname !== "/settings/credentials")
      void navigate("/");
  };
  return (
    <div className="min-h-screen lg:pl-60">
      <div className="fixed inset-y-0 left-0 z-20 hidden w-60 border-r border-border lg:block">
        <SiteSidebar user={user} org={org} orgs={orgs} onSelect={choose} onSignOut={signOut} />
      </div>
      <header
        className={cn("sticky top-0 z-10 h-14 border-b border-border bg-background", pageGutter)}
      >
        <div className={cn(pageContainer, "flex h-full items-center justify-between")}>
          <div className="lg:hidden">
            <Lockup compact />
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <UserMenu user={user} onSignOut={signOut} />
            <Button
              size="icon"
              variant="ghost"
              aria-label="Open Navigation"
              aria-haspopup="dialog"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(true)}
              className="lg:hidden"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 20 20"
                fill="none"
                stroke="currentColor"
                aria-hidden="true"
              >
                <path d="M3 5h14M3 10h14M3 15h14" />
              </svg>
            </Button>
          </div>
        </div>
      </header>
      <div className="flex min-h-[calc(100dvh_-_3.5rem)] min-w-0 flex-col">
        <Outlet context={{ org, orgs } satisfies OrgContext} key={org.login} />
      </div>
      {menuOpen && (
        <MobileSidebar
          user={user}
          org={org}
          orgs={orgs}
          onSelect={choose}
          onSignOut={signOut}
          onClose={() => setMenuOpen(false)}
        />
      )}
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
