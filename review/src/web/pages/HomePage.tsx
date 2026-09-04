import React from "react";
import {
  type ConnectedRepo,
  disconnectRepo,
  fetchConnectedRepos,
  formatAgo,
  setRepoContinuous,
} from "../api";
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
  const replace = (next: ConnectedRepo) =>
    setRepos((current) =>
      current.status === "ok"
        ? {
            status: "ok",
            repos: current.repos.map((r) => (r.fullName === next.fullName ? next : r)),
          }
        : current,
    );
  const toggleContinuous = (repo: ConnectedRepo) => {
    replace({ ...repo, continuous: !repo.continuous });
    setRepoContinuous(org.login, repo.fullName, !repo.continuous).then(replace, (cause: Error) => {
      replace(repo);
      setError(cause.message);
    });
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
        <div className="repo-cards">
          {repos.repos.map((repo) => (
            <article className="repo-card" key={repo.fullName}>
              <div className="repo-card-main">
                <div className="repo-card-name">
                  <a
                    className="repo-card-github"
                    href={`https://github.com/${repo.fullName}`}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`${repo.fullName} on GitHub`}
                    title="Open on GitHub"
                  >
                    <GitHubMark />
                  </a>
                  <span>{repo.fullName}</span>
                  {repo.private && <span className="repo-badge">private</span>}
                </div>
                <div className="repo-card-sub">
                  <span className="mono">{repo.defaultBranch}</span>
                  <span className="repo-detail-sep" aria-hidden="true">
                    ·
                  </span>
                  <span>
                    connected {formatAgo(repo.connectedAt)} by{" "}
                    <span className="mono">{repo.connectedBy}</span>
                  </span>
                </div>
              </div>
              <dl className="repo-card-stats">
                <div>
                  <dt>Tasks</dt>
                  <dd className="dim">none yet</dd>
                </div>
                <div>
                  <dt>Awaiting Review</dt>
                  <dd className="dim">0</dd>
                </div>
                <div>
                  <dt>Last PR</dt>
                  <dd className="dim">not yet scanned</dd>
                </div>
              </dl>
              <div className="repo-card-actions">
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={repo.continuous}
                    onChange={() => toggleContinuous(repo)}
                  />
                  <span className="switch-track" aria-hidden="true" />
                  <span className="switch-label">Continuous</span>
                </label>
                <button
                  type="button"
                  className="btn-icon"
                  onClick={() => disconnect(repo)}
                  aria-label={`Disconnect ${repo.fullName}`}
                  title="Disconnect"
                >
                  <UnlinkIcon />
                </button>
              </div>
            </article>
          ))}
        </div>
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

function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

/** A broken chain link. */
function UnlinkIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M6.5 9.5 3.7 12.3a2 2 0 0 0 2.8 2.8l1.6-1.6M9.5 6.5l2.8-2.8a2 2 0 0 0-2.8-2.8L7.9 2.5" />
      <path d="M2 2l2 2M12 12l2 2M1.5 6h2M6 1.5v2M14.5 10h-2M10 14.5v-2" />
    </svg>
  );
}
