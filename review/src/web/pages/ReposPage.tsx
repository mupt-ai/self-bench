import React from "react";
import { Link, useNavigate } from "react-router";
import {
  type ConnectedRepo,
  disconnectRepo,
  fetchConnectedRepos,
  fetchTasks,
  formatAgo,
  setRepoContinuous,
  type TaskItem,
} from "../api";
import { ConnectRepoSheet } from "../ConnectRepoSheet";
import { GitHubMark, UnlinkIcon, useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";

type Repos = { status: "loading" } | { status: "ok"; repos: ConnectedRepo[] };

interface RepoStats {
  tasks: number;
  needsReview: number;
  lastPr?: number;
}

function statsOf(tasks: TaskItem[]): RepoStats {
  let needsReview = 0;
  let lastPr: number | undefined;
  let kept = 0;
  for (const task of tasks) {
    if (task.state === "needs_review") needsReview += 1;
    if (task.state !== "rejected") kept += 1;
    if (task.sourcePr && (lastPr === undefined || task.sourcePr > lastPr)) lastPr = task.sourcePr;
  }
  return { tasks: kept, needsReview, ...(lastPr !== undefined ? { lastPr } : {}) };
}

export function ReposPage() {
  const { org } = useOrg();
  useDocumentTitle(`${org.login} · self-bench`);
  const [repos, setRepos] = React.useState<Repos>({ status: "loading" });
  const [error, setError] = React.useState<string | null>(null);
  const [connecting, setConnecting] = React.useState<"mine" | "public" | null>(null);
  const [stats, setStats] = React.useState<Record<string, RepoStats>>({});
  const navigate = useNavigate();
  /** The card is one target; its own controls (link, switch, disconnect) keep their behaviour. */
  const openRepo = (event: React.MouseEvent | React.KeyboardEvent, repo: ConnectedRepo) => {
    if ((event.target as HTMLElement).closest("a, button, label, input")) return;
    if ("key" in event && event.key !== "Enter") return;
    void navigate(`/repos/${repo.fullName}`);
  };

  React.useEffect(() => {
    let cancelled = false;
    fetchConnectedRepos(org.login).then(
      (found) => {
        if (cancelled) return;
        setRepos({ status: "ok", repos: found });
        // Counts come from the artifact store and can take a moment; fill cards as they arrive.
        for (const repo of found) {
          fetchTasks(org.login, repo.fullName).then(
            (tasks) =>
              !cancelled &&
              setStats((current) => ({ ...current, [repo.fullName]: statsOf(tasks) })),
            () => undefined,
          );
        }
      },
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
        <div className="repo-cards">
          {repos.repos.map((repo) => (
            <article
              className="repo-card"
              key={repo.fullName}
              onClick={(event) => openRepo(event, repo)}
              onKeyDown={(event) => openRepo(event, repo)}
            >
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
                  <Link className="repo-card-link" to={`/repos/${repo.fullName}`}>
                    {repo.fullName}
                  </Link>
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
              <RepoCardStats stats={stats[repo.fullName]} />
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

function RepoCardStats({ stats }: { stats: RepoStats | undefined }) {
  if (!stats) {
    return (
      <dl className="repo-card-stats">
        <div>
          <dt>Tasks</dt>
          <dd className="dim">…</dd>
        </div>
        <div>
          <dt>Awaiting Review</dt>
          <dd className="dim">…</dd>
        </div>
        <div>
          <dt>Last PR</dt>
          <dd className="dim">…</dd>
        </div>
      </dl>
    );
  }
  return (
    <dl className="repo-card-stats">
      <div>
        <dt>Tasks</dt>
        <dd className={stats.tasks === 0 ? "dim" : ""}>
          {stats.tasks === 0 ? "none yet" : stats.tasks}
        </dd>
      </div>
      <div>
        <dt>Awaiting Review</dt>
        <dd className={stats.needsReview === 0 ? "dim" : "attention"}>{stats.needsReview}</dd>
      </div>
      <div>
        <dt>Last PR</dt>
        <dd className={stats.lastPr === undefined ? "dim" : "mono"}>
          {stats.lastPr === undefined ? "not yet scanned" : `#${stats.lastPr}`}
        </dd>
      </div>
    </dl>
  );
}
