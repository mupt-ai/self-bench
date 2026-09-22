import React from "react";
import { Outlet, useLocation, useNavigate, useOutletContext } from "react-router";
import { Lockup } from "./Lockup";
import { pageGutter } from "./layout";
import { cn } from "./primitives/cn";
import { SidebarInset, SidebarTrigger } from "./primitives/sidebar";
import { MobileSidebar, SiteSidebar } from "./SiteSidebar";
import { defaultOrg, rememberOrg, type SiteOrg, type SiteUser, useSession } from "./session";
import { ThemeToggle } from "./ThemeToggle";
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
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(() => {
    try {
      return window.localStorage.getItem("selfbench.sidebar.collapsed") === "true";
    } catch {
      return false;
    }
  });
  const toggleSidebar = () => {
    setSidebarCollapsed((collapsed) => {
      const next = !collapsed;
      try {
        window.localStorage.setItem("selfbench.sidebar.collapsed", String(next));
      } catch {
        // Sidebar state is a convenience; keep the UI usable when storage is unavailable.
      }
      return next;
    });
  };
  React.useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)");
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
    if (location.pathname !== "/" && !location.pathname.startsWith("/settings/"))
      void navigate("/");
  };
  return (
    <div
      className={cn(
        "flex h-svh overflow-hidden transition-[padding] duration-200 ease-linear",
        sidebarCollapsed ? "md:pl-12" : "md:pl-64",
      )}
    >
      <div
        className={cn(
          "group/sidebar fixed inset-y-0 left-0 z-20 hidden border-r border-border bg-background text-sidebar-foreground transition-[width] duration-200 ease-linear md:block",
          sidebarCollapsed ? "w-12" : "w-64",
        )}
        data-state={sidebarCollapsed ? "collapsed" : "expanded"}
        data-collapsible={sidebarCollapsed ? "icon" : ""}
        data-variant="sidebar"
        data-side="left"
      >
        <SiteSidebar
          user={user}
          org={org}
          orgs={orgs}
          onSelect={choose}
          onSignOut={signOut}
          collapsed={sidebarCollapsed}
        />
      </div>
      <SidebarInset>
        <header
          className={cn("z-10 h-16 shrink-0 border-b border-border bg-background", pageGutter)}
        >
          <div className="flex h-full w-full min-w-0 items-center justify-between">
            <SidebarTrigger
              type="button"
              aria-label={sidebarCollapsed ? "Expand Sidebar" : "Collapse Sidebar"}
              title={sidebarCollapsed ? "Expand Sidebar" : "Collapse Sidebar"}
              onClick={toggleSidebar}
              className="-ml-2 hidden md:inline-flex"
            />
            <div className="md:hidden">
              <Lockup compact />
            </div>
            <div className="ml-auto flex items-center gap-2">
              <ThemeToggle />
              <UserMenu user={user} onSignOut={signOut} />
              <Button
                size="icon"
                variant="ghost"
                aria-label="Open Navigation"
                aria-haspopup="dialog"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen(true)}
                className="md:hidden"
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
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
          <Outlet context={{ org, orgs } satisfies OrgContext} key={org.login} />
        </div>
      </SidebarInset>
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
