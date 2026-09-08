import React from "react";
import { Link, useNavigate } from "react-router";
import {
  type ConnectedRepo,
  disconnectRepo,
  fetchConnectedRepos,
  fetchTaskCounts,
  formatAgo,
  type RepoTaskCounts,
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

function statsOf(counts: RepoTaskCounts | undefined): RepoStats {
  if (!counts) return { tasks: 0, needsReview: 0 };
  return {
    tasks: counts.total - counts.rejected,
    needsReview: counts.needsReview,
    ...(counts.lastPr !== undefined ? { lastPr: counts.lastPr } : {}),
  };
}

export function ReposPage() {
  const { org } = useOrg();
  useDocumentTitle(`${org.login} · self-bench`);
  const [repos, setRepos] = React.useState<Repos>({ status: "loading" });
  const [error, setError] = React.useState<string | null>(null);
  const [connecting, setConnecting] = React.useState<"mine" | "public" | null>(null);
  const [stats, setStats] = React.useState<Record<string, RepoStats>>({});
  const navigate = useNavigate();
  /** The card is one target; its own controls keep their behaviour. */
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
        fetchTaskCounts(org.login).then(
          (counts) =>
            !cancelled &&
            setStats(
              Object.fromEntries(
                found.map((repo) => [repo.fullName, statsOf(counts[repo.fullName])]),
              ),
            ),
          () => undefined,
        );
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
    <main className="w-full min-w-0 flex-1 px-4 pt-8 pb-12 sm:px-[var(--site-gutter)]">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-6 [&_h1]:mt-1.5 [&_h1]:font-sans [&_h1]:text-xl [&_h1]:leading-tight [&_h1]:font-semibold">
        <div>
          <div className="font-mono text-sm font-medium tracking-[0.14em] text-mint uppercase">
            Repositories
          </div>
          <h1>Connected Repositories</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            className="inline-flex h-9 shrink-0 items-center justify-center border border-line-strong bg-transparent px-4 font-sans text-sm font-bold text-ink hover:border-mint hover:text-mint-bright"
            onClick={() => setConnecting("public")}
          >
            + Connect Public Repo
          </button>
          <button
            type="button"
            className="inline-flex h-9 shrink-0 items-center justify-center gap-2 border border-mint bg-mint px-4 font-sans text-sm font-bold text-bg hover:bg-mint-bright disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => setConnecting("mine")}
          >
            + Connect My Repo
          </button>
        </div>
      </div>
      {error && <p className="mb-4 font-mono text-base text-danger">{error}</p>}
      {repos.status === "ok" && repos.repos.length === 0 && (
        <div className="border border-dashed border-line-strong px-6 py-12 text-center text-muted">
          <p>Nothing connected yet. Connect a repository in {org.login} to start building tasks.</p>
        </div>
      )}
      {repos.status === "ok" && repos.repos.length > 0 && (
        <div className="flex flex-col gap-3">
          {repos.repos.map((repo) => (
            <article
              className="grid cursor-pointer grid-cols-1 items-center gap-5 border border-line bg-surface px-5 py-4.5 hover:border-mint hover:bg-surface-2 lg:grid-cols-[minmax(240px,1.2fr)_minmax(0,2fr)_auto] lg:gap-8"
              key={repo.fullName}
              onClick={(event) => openRepo(event, repo)}
              onKeyDown={(event) => openRepo(event, repo)}
            >
              <div className="repo-card-main">
                <div className="flex min-w-0 items-center gap-2.5 font-mono text-base font-medium text-ink [&>span:first-of-type]:truncate">
                  <a
                    className="inline-flex shrink-0 text-muted hover:text-mint-bright [&_svg]:size-4 [&_svg]:fill-current"
                    href={`https://github.com/${repo.fullName}`}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`${repo.fullName} on GitHub`}
                    title="Open on GitHub"
                  >
                    <GitHubMark />
                  </a>
                  <Link className="hover:text-mint-bright" to={`/repos/${repo.fullName}`}>
                    {repo.fullName}
                  </Link>
                  {repo.private && (
                    <span className="text-sm tracking-widest text-warning uppercase">private</span>
                  )}
                </div>
                <div className="mt-1.5 flex gap-2 text-sm text-muted">
                  <span className="font-mono">{repo.defaultBranch}</span>
                  <span className="text-line-strong" aria-hidden="true">
                    ·
                  </span>
                  <span>
                    connected {formatAgo(repo.connectedAt)} by{" "}
                    <span className="font-mono">{repo.connectedBy}</span>
                  </span>
                </div>
              </div>
              <RepoCardStats stats={stats[repo.fullName]} />
              <div className="flex items-center gap-5 justify-self-end">
                <button
                  type="button"
                  className="inline-flex size-8 items-center justify-center border border-transparent text-dim hover:border-line-strong hover:text-danger [&_svg]:size-4"
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
      <dl className="m-0 grid grid-cols-3 gap-6 [&_dt]:font-mono [&_dt]:text-sm [&_dt]:font-medium [&_dt]:tracking-[0.14em] [&_dt]:text-dim [&_dt]:uppercase [&_dd]:mt-1.5 [&_dd]:font-sans [&_dd]:text-base [&_dd]:font-medium [&_dd]:text-ink">
        <div>
          <dt>Tasks</dt>
          <dd className="text-dim">…</dd>
        </div>
        <div>
          <dt>Awaiting Review</dt>
          <dd className="text-dim">…</dd>
        </div>
        <div>
          <dt>Last PR</dt>
          <dd className="text-dim">…</dd>
        </div>
      </dl>
    );
  }
  return (
    <dl className="m-0 grid grid-cols-3 gap-6 [&_dt]:font-mono [&_dt]:text-sm [&_dt]:font-medium [&_dt]:tracking-[0.14em] [&_dt]:text-dim [&_dt]:uppercase [&_dd]:mt-1.5 [&_dd]:font-sans [&_dd]:text-base [&_dd]:font-medium [&_dd]:text-ink">
      <div>
        <dt>Tasks</dt>
        <dd className={stats.tasks === 0 ? "text-dim" : ""}>{stats.tasks}</dd>
      </div>
      <div>
        <dt>Awaiting Review</dt>
        <dd className={stats.needsReview === 0 ? "text-dim" : "text-warning"}>
          {stats.needsReview}
        </dd>
      </div>
      <div>
        <dt>Last PR</dt>
        <dd className={stats.lastPr === undefined ? "text-dim" : "font-mono"}>
          {stats.lastPr === undefined ? "not yet scanned" : `#${stats.lastPr}`}
        </dd>
      </div>
    </dl>
  );
}
