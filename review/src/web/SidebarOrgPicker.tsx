import { ChevronDown } from "lucide-react";
import React from "react";
import { Avatar } from "./Dropdown";
import { cn } from "./primitives/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./primitives/dropdown-menu";
import type { SiteOrg } from "./session";

/** Switch accounts without taking space from the sidebar navigation. */
export function SidebarOrgPicker({
  org,
  orgs,
  onSelect,
  collapsed = false,
}: {
  org: SiteOrg;
  orgs: SiteOrg[];
  onSelect: (org: SiteOrg) => void;
  collapsed?: boolean;
}) {
  const root = React.useRef<HTMLDivElement>(null);
  const [container, setContainer] = React.useState<HTMLElement | null>(null);
  React.useEffect(() => {
    setContainer(
      root.current?.closest("dialog") ?? root.current?.closest<HTMLElement>(".sb") ?? null,
    );
  }, []);
  const personal = orgs.filter((item) => item.kind === "user");
  const organizations = orgs.filter((item) => item.kind === "org");
  return (
    <div ref={root}>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Organization"
            className={cn(
              "flex h-9 w-full min-w-0 cursor-pointer items-center gap-2 border border-border bg-transparent px-3 text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand",
              collapsed && "justify-center px-0",
            )}
          >
            <span className="shrink-0 overflow-hidden border border-border">
              <Avatar login={org.login} url={org.avatarUrl} size={20} />
            </span>
            {!collapsed && <span className="min-w-0 flex-1 truncate text-left">{org.login}</span>}
            {!collapsed && <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          container={container}
          side="top"
          align="start"
          className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-52 max-w-[calc(100vw-24px)] p-1.5"
          aria-label="Switch Organization"
        >
          <DropdownMenuRadioGroup
            value={org.login}
            onValueChange={(login) => {
              const selected = orgs.find((item) => item.login === login);
              if (selected) onSelect(selected);
            }}
          >
            {personal.map((item) => (
              <OrgItem key={item.login} org={item} />
            ))}
            {organizations.length > 0 && (
              <>
                {personal.length > 0 && <DropdownMenuSeparator />}
                <DropdownMenuLabel className="px-2 pt-2 pb-1 font-mono text-xs text-muted-foreground">
                  Organizations
                </DropdownMenuLabel>
                {organizations.map((item) => (
                  <OrgItem key={item.login} org={item} />
                ))}
              </>
            )}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function OrgItem({ org }: { org: SiteOrg }) {
  return (
    <DropdownMenuRadioItem
      value={org.login}
      className="min-h-9 gap-2.5 py-1.5 data-[state=checked]:bg-brand/5"
    >
      <span className="shrink-0 overflow-hidden border border-border">
        <Avatar login={org.login} url={org.avatarUrl} size={24} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-sm leading-5">{org.login}</span>
        {org.kind === "user" && (
          <span className="block font-mono text-xs leading-5 text-muted-foreground">
            Personal Account
          </span>
        )}
      </span>
    </DropdownMenuRadioItem>
  );
}
