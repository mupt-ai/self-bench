import { FolderGit2, Settings2 } from "lucide-react";
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
    <aside data-slot="sidebar" className="flex h-full min-h-0 flex-col bg-bg">
      <SidebarHeader className="h-20 justify-center px-5 [&_a]:mb-0 [&_a]:justify-start [&_a]:gap-2.5 [&_a_svg]:size-6 [&_strong]:text-[18px] [&_a_span_span]:text-[10px]">
        <Lockup />
      </SidebarHeader>
      <SidebarContent className="px-3 pt-2">
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
      <SidebarFooter className="mx-3 gap-0 border-t border-line px-0 pt-2 pb-3">
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
      className="fixed inset-y-0 left-0 m-0 h-dvh max-h-none w-72 max-w-[calc(100%_-_2rem)] border-0 border-r border-line bg-surface p-0 text-ink backdrop:bg-black/70"
    >
      <button
        ref={close}
        type="button"
        aria-label="Close Navigation"
        onClick={props.onClose}
        className="absolute top-2 right-2 grid size-8 place-items-center text-muted hover:text-mint"
      >
        ×
      </button>
      <SiteSidebar {...props} onNavigate={props.onClose} />
    </dialog>
  );
}
