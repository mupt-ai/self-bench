import React from "react";
import { type ConnectedRepo, disconnectRepo, fetchConnectedRepos, formatAgo } from "../api";
import { ConnectRepoSheet } from "../ConnectRepoSheet";
import { Lockup } from "../Lockup";
import { OrgSwitcher } from "../OrgSwitcher";
import {
  defaultOrg,
  rememberOrg,
  type SiteOrg,
  type SiteUser,
  useDocumentTitle,
  useSession,
} from "../session";
import { UserMenu } from "../UserMenu";

/** The signed-in shell: lockup, org switcher, account menu, and the org's connected repos. */
export function HomePage({ user, orgs }: { user: SiteUser; orgs: SiteOrg[] }) {
  const { signOut } = useSession();
  const [org, setOrg] = React.useState(() => defaultOrg(orgs));
  useDocumentTitle(`${org.login} · self-bench`);
  const choose = (next: SiteOrg) => {
    rememberOrg(next.login);
    setOrg(next);
  };
  return (
    <div className="site-shell">
      <header className="site-bar">
        <div className="site-bar-left">
          <Lockup />
          <OrgSwitcher orgs={orgs} current={org} onSelect={choose} />
        </div>
        <UserMenu user={user} onSignOut={signOut} />
      </header>
      <ReposPage key={org.login} org={org} />
    </div>
  );
}

type Repos = { status: "loading" } | { status: "ok"; repos: ConnectedRepo[] };

function ReposPage({ org }: { org: SiteOrg }) {
  const [repos, setRepos] = React.useState<Repos>({ status: "loading" });
  const [error, setError] = React.useState<string | null>(null);
  const [connecting, setConnecting] = React.useState<"mine" | "public" | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetchConnectedRepos(org.login).then(
      (found) => !cancelled && setRepos({ status: "ok", repos: found }),
      (cause: Error) => !cancelled && setError(cause.message),
    );
    return () => {
      cancelled = true;
    };
  }, [org.login]);

  const closeSheet = React.useCallback(() => setConnecting(null), []);
  const onConnected = React.useCallback((repo: ConnectedRepo) => {
    setRepos((current) =>
      current.status === "ok" ? { status: "ok", repos: [repo, ...current.repos] } : current,
    );
    setConnecting(null);
  }, []);
  const disconnect = (repo: ConnectedRepo) => {
    if (!window.confirm(`Disconnect ${repo.fullName}?`)) return;
    disconnectRepo(org.login, repo.fullName).then(
      () =>
        setRepos((current) =>
          current.status === "ok"
            ? { status: "ok", repos: current.repos.filter((r) => r.fullName !== repo.fullName) }
            : current,
        ),
      (cause: Error) => setError(cause.message),
    );
  };
  const connected = new Set(
    repos.status === "ok" ? repos.repos.map((r) => r.fullName.toLowerCase()) : [],
  );

  return (
    <main className="site-main">
      <div className="page-head">
        <div>
          <div className="eyebrow">Repositories</div>
          <h1>Connected Repositories</h1>
        </div>
        <div className="page-actions">
          <button type="button" className="btn-secondary" onClick={() => setConnecting("public")}>
            + Connect Public Repo
          </button>
          <button type="button" className="btn-primary" onClick={() => setConnecting("mine")}>
            + Connect My Repo
          </button>
        </div>
      </div>
      {error && <p className="page-error">{error}</p>}
      {repos.status === "ok" && repos.repos.length === 0 && (
        <div className="empty-state">
          <p>Nothing connected yet. Connect a repository in {org.login} to start building tasks.</p>
        </div>
      )}
      {repos.status === "ok" && repos.repos.length > 0 && (
        <table className="repo-table">
          <thead>
            <tr>
              <th>Repository</th>
              <th>Branch</th>
              <th>Tasks</th>
              <th>Connected</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {repos.repos.map((repo) => (
              <tr key={repo.fullName}>
                <td>
                  <span className="repo-cell-name">
                    {repo.fullName}
                    {repo.private && <span className="repo-badge">private</span>}
                  </span>
                </td>
                <td className="repo-cell-muted">{repo.defaultBranch}</td>
                <td className="repo-cell-dim">none yet</td>
                <td className="repo-cell-muted">
                  {formatAgo(repo.connectedAt)} by {repo.connectedBy}
                </td>
                <td className="repo-cell-actions">
                  <button type="button" className="btn-text" onClick={() => disconnect(repo)}>
                    Disconnect
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {connecting && (
        <ConnectRepoSheet
          org={org}
          mode={connecting}
          connected={connected}
          onClose={closeSheet}
          onConnected={onConnected}
        />
      )}
    </main>
  );
}
