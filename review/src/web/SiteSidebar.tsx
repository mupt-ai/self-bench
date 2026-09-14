import { FolderGit2, LockKeyhole, X } from "lucide-react";
import React from "react";
import { Link, useLocation } from "react-router";
import { Lockup } from "./Lockup";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "./primitives/sidebar";
import { SidebarOrgPicker } from "./SidebarOrgPicker";
import type { SiteOrg, SiteUser } from "./session";
import { Button } from "./ui";
import { useModalDialog } from "./useModalDialog";

interface SidebarProps {
  user: SiteUser;
  org: SiteOrg;
  orgs: SiteOrg[];
  onSelect: (org: SiteOrg) => void;
  onSignOut: () => Promise<void>;
  onNavigate?: () => void;
  collapsed?: boolean;
}

export function SiteSidebar({ org, orgs, onSelect, onNavigate, collapsed = false }: SidebarProps) {
  const { pathname } = useLocation();
  return (
    <aside data-slot="sidebar" className="flex h-full min-h-0 flex-col bg-background">
      <SidebarHeader
        className={`h-14 shrink-0 border-b border-border ${collapsed ? "items-center justify-center px-2" : "justify-center px-4"}`}
      >
        <Lockup compact showName={!collapsed} />
      </SidebarHeader>
      <SidebarContent className="px-2 py-2">
        <nav aria-label="Organization Navigation">
          <SidebarGroupLabel className={collapsed ? "-mt-8 opacity-0" : undefined}>
            Workspace
          </SidebarGroupLabel>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                className={collapsed ? "justify-center px-0" : undefined}
                isActive={pathname === "/" || pathname.startsWith("/repos/")}
              >
                <Link to="/" onClick={onNavigate} aria-label="Repositories" title="Repositories">
                  <FolderGit2 />
                  {!collapsed && <span>Repositories</span>}
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                className={collapsed ? "justify-center px-0" : undefined}
                asChild
                isActive={pathname.startsWith("/settings/")}
              >
                <Link
                  to="/settings/credentials"
                  onClick={onNavigate}
                  aria-label="Credentials"
                  title="Credentials"
                >
                  <LockKeyhole />
                  {!collapsed && <span>Credentials</span>}
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </nav>
      </SidebarContent>
      <SidebarFooter className="gap-0 border-t border-border p-2">
        <SidebarOrgPicker org={org} orgs={orgs} onSelect={onSelect} collapsed={collapsed} />
      </SidebarFooter>
    </aside>
  );
}

export function MobileSidebar(props: SidebarProps & { onClose: () => void }) {
  const close = React.useRef<HTMLButtonElement>(null);
  const dialog = useModalDialog(close);
  return (
    <dialog
      ref={dialog}
      aria-label="Navigation"
      onCancel={(event) => {
        event.preventDefault();
        props.onClose();
      }}
      className="fixed inset-y-0 left-0 m-0 h-dvh max-h-none w-72 max-w-[calc(100%_-_2rem)] border-0 border-r border-border bg-card p-0 text-foreground backdrop:bg-black/70"
    >
      <Button
        size="icon"
        variant="ghost"
        ref={close}
        type="button"
        aria-label="Close Navigation"
        onClick={props.onClose}
        className="absolute top-2 right-2"
      >
        <X aria-hidden="true" />
      </Button>
      <SiteSidebar {...props} onNavigate={props.onClose} />
    </dialog>
  );
}
