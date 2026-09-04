import { useNavigate } from "react-router";
import { Avatar, Dropdown } from "./Dropdown";
import { rememberOrg, type SiteOrg } from "./session";

/** The current tenant beside the lockup; the menu lists every org the user belongs to. */
export function OrgSwitcher({ orgs, current }: { orgs: SiteOrg[]; current: SiteOrg }) {
  const navigate = useNavigate();
  const personal = orgs.filter((org) => org.kind === "user");
  const organizations = orgs.filter((org) => org.kind === "org");
  const choose = (org: SiteOrg, close: () => void) => {
    close();
    rememberOrg(org.login);
    void navigate(`/${encodeURIComponent(org.login)}`);
  };
  const item = (org: SiteOrg, close: () => void) => (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={org.login === current.login}
      key={org.login}
      className={`dropdown-item org-item ${org.login === current.login ? "current" : ""}`}
      onClick={() => choose(org, close)}
    >
      <Avatar login={org.login} url={org.avatarUrl} size={20} />
      <span className="org-item-login">{org.login}</span>
      {org.role === "admin" && org.kind === "org" && <span className="org-item-role">admin</span>}
    </button>
  );
  return (
    <Dropdown
      label="Organization"
      className="org-switcher"
      align="left"
      trigger={
        <>
          <span className="org-slash" aria-hidden="true">
            /
          </span>
          <Avatar login={current.login} url={current.avatarUrl} size={20} />
          <span className="dropdown-text">{current.login}</span>
        </>
      }
    >
      {(close) => (
        <>
          <div className="dropdown-head">
            <div className="eyebrow">Personal</div>
          </div>
          {personal.map((org) => item(org, close))}
          {organizations.length > 0 && (
            <>
              <div className="dropdown-head">
                <div className="eyebrow">Organizations</div>
              </div>
              {organizations.map((org) => item(org, close))}
            </>
          )}
        </>
      )}
    </Dropdown>
  );
}
