import { FolderGit2, Settings2, X } from "lucide-react";
import React from "react";
import { Link, useLocation } from "react-router";
import { Lockup } from "./Lockup";
import {
  SidebarContent,
  SidebarFooter,
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
}

export function SiteSidebar({ org, orgs, onSelect, onNavigate }: SidebarProps) {
  const { pathname } = useLocation();
  return (
    <aside data-slot="sidebar" className="flex h-full min-h-0 flex-col bg-background">
      <SidebarHeader className="h-14 shrink-0 justify-center border-b border-border px-4">
        <Lockup compact />
      </SidebarHeader>
      <SidebarContent className="px-3 py-4">
        <nav aria-label="Organization Navigation">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                isActive={pathname === "/" || pathname.startsWith("/repos/")}
              >
                <Link to="/" onClick={onNavigate}>
                  <FolderGit2 />
                  <span>Repositories</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={pathname.startsWith("/settings/")}>
                <Link
                  to="/settings/credentials"
                  onClick={onNavigate}
                  aria-label="Organization Settings"
                >
                  <Settings2 />
                  <span>Settings</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </nav>
      </SidebarContent>
      <SidebarFooter className="mx-3 gap-0 border-t border-border px-0 pt-2 pb-3">
        <SidebarOrgPicker org={org} orgs={orgs} onSelect={onSelect} />
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
