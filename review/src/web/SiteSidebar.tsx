import {
  BookOpen,
  CreditCard,
  FlaskConical,
  FolderGit2,
  Gauge,
  KeyRound,
  LockKeyhole,
  type LucideIcon,
  Rocket,
  Users,
  X,
} from "lucide-react";
import React from "react";
import { Link, useLocation } from "react-router";
import { EVAL_OWNER } from "../../../src/contracts/evals";
import { Lockup } from "./Lockup";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
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
  /** Show the Billing page, which only exists with the managed offering. */
  billing: boolean;
  /** Opens the setup popup; offered until the org can generate and evaluate. */
  onSetup?: () => void;
}

/** One page in the sidebar: where it goes, and which paths mark it as the page you are on. */
interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  active: (pathname: string) => boolean;
  /** Opens another site in a new tab instead of a page of the app. */
  external?: boolean;
}

/** SelfBench's documentation, a separate Mintlify site (docs/). */
const DOCS_URL = "https://docs.selfbench.dev";

/** The sidebar's sections, in order: the benchmarks, the workspace itself, and help. */
function sectionsOf(billing: boolean): { label: string; items: NavItem[] }[] {
  return [
    {
      label: "Benchmarks",
      items: [
        {
          // Repositories and groups of repositories, mined from coding repos.
          label: "Mined Repos",
          to: "/",
          icon: FolderGit2,
          active: (path) =>
            path === "/" ||
            path.startsWith("/groups") ||
            (path.startsWith("/repos/") && !path.startsWith(`/repos/${EVAL_OWNER}/`)),
        },
        {
          label: "Scenarios",
          to: "/evals",
          icon: FlaskConical,
          active: (path) => path.startsWith("/evals") || path.startsWith(`/repos/${EVAL_OWNER}/`),
        },
        {
          label: "Public Benchmarks",
          to: "/benchmarks",
          icon: Gauge,
          active: (path) => path.startsWith("/benchmarks"),
        },
      ],
    },
    {
      label: "Workspace",
      items: [
        {
          label: "Members",
          to: "/settings/members",
          icon: Users,
          active: (path) => path.startsWith("/settings/members"),
        },
        {
          label: "Credentials",
          to: "/settings/credentials",
          icon: LockKeyhole,
          active: (path) => path.startsWith("/settings/credentials"),
        },
        {
          label: "API Keys",
          to: "/settings/api-keys",
          icon: KeyRound,
          active: (path) => path.startsWith("/settings/api-keys"),
        },
        ...(billing
          ? [
              {
                label: "Billing",
                to: "/settings/billing",
                icon: CreditCard,
                active: (path: string) => path.startsWith("/settings/billing"),
              },
            ]
          : []),
      ],
    },
    {
      label: "Help",
      items: [{ label: "Docs", to: DOCS_URL, icon: BookOpen, active: () => false, external: true }],
    },
  ];
}

export function SiteSidebar({
  org,
  orgs,
  onSelect,
  onNavigate,
  collapsed = false,
  billing,
  onSetup,
}: SidebarProps) {
  const { pathname } = useLocation();
  return (
    <aside data-slot="sidebar" className="flex h-full min-h-0 flex-col bg-background">
      <SidebarHeader className="flex h-16 shrink-0 flex-row items-center border-b border-border px-5 group-data-[collapsible=icon]/sidebar:justify-center group-data-[collapsible=icon]/sidebar:px-0">
        <Lockup compact showName={!collapsed} />
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label="Workspace Navigation" className="flex flex-col gap-3 pt-4">
          {onSetup && (
            <SidebarGroup className="py-0">
              <SidebarMenu>
                <SidebarMenuItem>
                  <NavTooltip collapsed={collapsed} label="Finish Setup">
                    <SidebarMenuButton
                      type="button"
                      aria-label="Finish Setup"
                      onClick={() => {
                        onNavigate?.();
                        onSetup();
                      }}
                    >
                      <Rocket />
                      {!collapsed && <span className="flex-1">Finish Setup</span>}
                      <span
                        aria-hidden="true"
                        className="size-2 shrink-0 bg-brand group-data-[collapsible=icon]/sidebar:absolute group-data-[collapsible=icon]/sidebar:top-1.5 group-data-[collapsible=icon]/sidebar:right-1.5"
                      />
                    </SidebarMenuButton>
                  </NavTooltip>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroup>
          )}
          {sectionsOf(billing).map((section, index) => {
            const heading = `sidebar-section-${section.label.toLowerCase()}`;
            return (
              <SidebarGroup
                key={section.label}
                role="group"
                aria-labelledby={collapsed ? undefined : heading}
                aria-label={collapsed ? section.label : undefined}
                className="py-0"
              >
                {collapsed ? (
                  // Icons alone: a rule between sections stands in for their names.
                  index > 0 && (
                    <span aria-hidden="true" className="mx-1 mb-2 block border-t border-border" />
                  )
                ) : (
                  <h2 id={heading} className="px-2.5 pb-1 text-sm font-normal text-(--faint)">
                    {section.label}
                  </h2>
                )}
                <SidebarGroupContent>
                  <SidebarMenu>
                    {section.items.map((item) => (
                      <SidebarMenuItem key={item.to}>
                        <NavTooltip collapsed={collapsed} label={item.label}>
                          <SidebarMenuButton asChild isActive={item.active(pathname)}>
                            {item.external ? (
                              <a
                                href={item.to}
                                target="_blank"
                                rel="noreferrer"
                                onClick={onNavigate}
                                aria-label={item.label}
                              >
                                <item.icon />
                                {!collapsed && <span>{item.label}</span>}
                              </a>
                            ) : (
                              <Link to={item.to} onClick={onNavigate} aria-label={item.label}>
                                <item.icon />
                                {!collapsed && <span>{item.label}</span>}
                              </Link>
                            )}
                          </SidebarMenuButton>
                        </NavTooltip>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            );
          })}
        </nav>
      </SidebarContent>
      <div className="border-t border-border p-3 group-data-[collapsible=icon]/sidebar:p-2">
        <SidebarOrgPicker org={org} orgs={orgs} onSelect={onSelect} collapsed={collapsed} />
      </div>
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
      className="fixed inset-y-0 left-0 m-0 h-dvh max-h-none w-72 max-w-[calc(100%_-_2rem)] border-0 border-r border-border bg-background p-0 text-foreground backdrop:bg-foreground/30 backdrop:backdrop-blur-[2px]"
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
