import { ChevronsUpDown } from "lucide-react";
import React from "react";
import { Avatar } from "./Dropdown";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./primitives/dropdown-menu";
import { SidebarMenuButton } from "./primitives/sidebar";
import type { SiteOrg } from "./session";

/** The org picker pinned to the bottom of the sidebar. */
export function SidebarOrgPicker({
  org,
  orgs,
  onSelect,
}: {
  org: SiteOrg;
  orgs: SiteOrg[];
  onSelect: (org: SiteOrg) => void;
}) {
  const root = React.useRef<HTMLDivElement>(null);
  const [container, setContainer] = React.useState<HTMLElement | null>(null);
  React.useEffect(() => setContainer(root.current?.closest("dialog") ?? null), []);
  const personal = orgs.filter((item) => item.kind === "user");
  const organizations = orgs.filter((item) => item.kind === "org");
  return (
    <div ref={root}>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton
            size="lg"
            aria-label="Organization"
            className="border border-line hover:border-line-strong"
          >
            <Avatar login={org.login} url={org.avatarUrl} size={26} />
            <span className="min-w-0 flex-1 truncate text-ink">{org.login}</span>
            <ChevronsUpDown className="text-dim" />
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          container={container}
          side="top"
          align="start"
          className="w-64"
          aria-label="Switch Organization"
        >
          <DropdownMenuLabel>Switch Organization</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup
            value={org.login}
            onValueChange={(login) => {
              const selected = orgs.find((item) => item.login === login);
              if (selected) onSelect(selected);
            }}
          >
            <DropdownMenuLabel className="font-mono text-xs font-medium tracking-[0.14em] text-mint uppercase">
              Personal
            </DropdownMenuLabel>
            {personal.map((item) => (
              <OrgItem key={item.login} org={item} />
            ))}
            {organizations.length > 0 && (
              <DropdownMenuLabel className="font-mono text-xs font-medium tracking-[0.14em] text-mint uppercase">
                Organizations
              </DropdownMenuLabel>
            )}
            {organizations.map((item) => (
              <OrgItem key={item.login} org={item} />
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function OrgItem({ org }: { org: SiteOrg }) {
  return (
    <DropdownMenuRadioItem value={org.login}>
      <Avatar login={org.login} url={org.avatarUrl} size={20} />
      <span className="min-w-0 flex-1 truncate">{org.login}</span>
      {org.kind === "org" && org.role === "admin" && (
        <span className="font-mono text-sm tracking-widest text-dim uppercase">admin</span>
      )}
    </DropdownMenuRadioItem>
  );
}
