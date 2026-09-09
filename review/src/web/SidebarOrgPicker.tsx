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
import type { SiteOrg } from "./session";

/** Switch accounts without taking space from the sidebar navigation. */
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
            className="group flex min-h-14 w-full cursor-pointer items-center gap-3 border border-transparent px-2.5 py-2 text-left transition-colors hover:border-mint/60 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-mint data-[state=open]:border-mint data-[state=open]:bg-surface-2"
          >
            <span className="shrink-0 overflow-hidden border border-line">
              <Avatar login={org.login} url={org.avatarUrl} size={28} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-sans text-[15px] font-semibold leading-5 text-ink">
                {org.login}
              </span>
              <span className="block font-sans text-xs leading-5 text-dim">
                {org.kind === "user" ? "Personal Account" : "Organization"}
              </span>
            </span>
            <ChevronsUpDown
              aria-hidden="true"
              className="size-3.5 shrink-0 text-dim transition-colors group-hover:text-mint-bright"
            />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          container={container}
          side="top"
          align="start"
          className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-0 max-w-[calc(100vw-24px)] p-1.5"
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
                <DropdownMenuLabel className="px-2 pt-2 pb-1 font-sans text-xs text-dim">
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
      className="min-h-9 gap-2.5 py-1.5 data-[state=checked]:bg-mint/5"
    >
      <span className="shrink-0 overflow-hidden border border-line">
        <Avatar login={org.login} url={org.avatarUrl} size={24} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-sans text-sm leading-5">{org.login}</span>
        {org.kind === "user" && (
          <span className="block font-sans text-xs leading-5 text-dim">Personal Account</span>
        )}
      </span>
    </DropdownMenuRadioItem>
  );
}
