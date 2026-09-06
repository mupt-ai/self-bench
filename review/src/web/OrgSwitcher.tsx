import { Avatar, Dropdown } from "./Dropdown";
import type { SiteOrg } from "./session";

export interface OrgSwitcherProps {
  orgs: SiteOrg[];
  current: SiteOrg;
  onSelect: (org: SiteOrg) => void;
}

/** The current tenant beside the lockup; the menu lists every org the user belongs to. */
export function OrgSwitcher({ orgs, current, onSelect }: OrgSwitcherProps) {
  const personal = orgs.filter((org) => org.kind === "user");
  const organizations = orgs.filter((org) => org.kind === "org");
  const choose = (org: SiteOrg, close: () => void) => {
    close();
    onSelect(org);
  };
  const item = (org: SiteOrg, close: () => void) => (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={org.login === current.login}
      key={org.login}
      className={`flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left font-mono text-xs font-medium text-ink hover:bg-surface-3 hover:text-mint-bright disabled:cursor-default disabled:opacity-50  ${org.login === current.login ? "text-mint after:ml-auto after:text-mint after:content-['✓']" : ""}`}
      onClick={() => choose(org, close)}
    >
      <Avatar login={org.login} url={org.avatarUrl} size={20} />
      <span className="min-w-0 flex-1 truncate">{org.login}</span>
      {org.role === "admin" && org.kind === "org" && (
        <span className="font-mono text-[10px] tracking-widest text-dim uppercase">admin</span>
      )}
    </button>
  );
  return (
    <Dropdown
      label="Organization"
      className="org-switcher"
      align="left"
      trigger={
        <>
          <span
            className="mr-0.5 font-mono text-lg leading-none text-line-strong"
            aria-hidden="true"
          >
            /
          </span>
          <Avatar login={current.login} url={current.avatarUrl} size={20} />
          <span className="max-w-24 truncate sm:max-w-40">{current.login}</span>
        </>
      }
    >
      {(close) => (
        <>
          <div className="px-3.5 pt-3 pb-2">
            <div className="font-mono text-[10px] font-medium tracking-[0.14em] text-mint uppercase">
              Personal
            </div>
          </div>
          {personal.map((org) => item(org, close))}
          {organizations.length > 0 && (
            <>
              <div className="px-3.5 pt-3 pb-2">
                <div className="font-mono text-[10px] font-medium tracking-[0.14em] text-mint uppercase">
                  Organizations
                </div>
              </div>
              {organizations.map((org) => item(org, close))}
            </>
          )}
        </>
      )}
    </Dropdown>
  );
}
