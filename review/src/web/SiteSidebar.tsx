import { CreditCard, FolderGit2, KeyRound, LockKeyhole, X } from "lucide-react";
import React from "react";
import { Link, useLocation } from "react-router";
import { Lockup } from "./Lockup";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "./primitives/sidebar";
import { InfoTooltip } from "./primitives/tooltip";
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
      <SidebarHeader className="flex h-14 shrink-0 flex-row items-center border-b border-border px-4 group-data-[collapsible=icon]/sidebar:px-2">
        <Lockup compact showName={!collapsed} />
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label="Organization Navigation">
          <SidebarGroup>
            <SidebarGroupLabel>Workspace</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <NavTooltip collapsed={collapsed} label="Repositories">
                    <SidebarMenuButton
                      asChild
                      isActive={pathname === "/" || pathname.startsWith("/repos/")}
                    >
                      <Link to="/" onClick={onNavigate} aria-label="Repositories">
                        <FolderGit2 />
                        {!collapsed && <span>Repositories</span>}
                      </Link>
                    </SidebarMenuButton>
                  </NavTooltip>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <NavTooltip collapsed={collapsed} label="Credentials">
                    <SidebarMenuButton
                      asChild
                      isActive={pathname.startsWith("/settings/credentials")}
                    >
                      <Link
                        to="/settings/credentials"
                        onClick={onNavigate}
                        aria-label="Credentials"
                      >
                        <LockKeyhole />
                        {!collapsed && <span>Credentials</span>}
                      </Link>
                    </SidebarMenuButton>
                  </NavTooltip>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <NavTooltip collapsed={collapsed} label="API Keys">
                    <SidebarMenuButton asChild isActive={pathname.startsWith("/settings/api-keys")}>
                      <Link to="/settings/api-keys" onClick={onNavigate} aria-label="API Keys">
                        <KeyRound />
                        {!collapsed && <span>API Keys</span>}
                      </Link>
                    </SidebarMenuButton>
                  </NavTooltip>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <NavTooltip collapsed={collapsed} label="Billing">
                    <SidebarMenuButton asChild isActive={pathname.startsWith("/settings/billing")}>
                      <Link to="/settings/billing" onClick={onNavigate} aria-label="Billing">
                        <CreditCard />
                        {!collapsed && <span>Billing</span>}
                      </Link>
                    </SidebarMenuButton>
                  </NavTooltip>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </nav>
      </SidebarContent>
      <SidebarFooter className="border-t border-border p-3 group-data-[collapsible=icon]/sidebar:p-2">
        <SidebarOrgPicker org={org} orgs={orgs} onSelect={onSelect} collapsed={collapsed} />
      </SidebarFooter>
    </aside>
  );
}

/** The collapsed sidebar's icon buttons are labeled by a hover tooltip, like the shadcn primitive. */
function NavTooltip({
  collapsed,
  label,
  children,
}: {
  collapsed: boolean;
  label: string;
  children: React.ReactNode;
}) {
  if (!collapsed) return <>{children}</>;
  return <InfoTooltip label={label}>{children}</InfoTooltip>;
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
