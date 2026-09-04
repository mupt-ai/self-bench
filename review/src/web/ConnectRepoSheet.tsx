import React from "react";
import {
  type ConnectedRepo,
  connectRepo,
  fetchGitHubRepoDetail,
  fetchGitHubRepos,
  formatAgo,
  type Repo,
  type RepoDetail,
} from "./api";
import type { SiteOrg } from "./session";

export interface ConnectRepoSheetProps {
  org: SiteOrg;
  /** "mine" lists the org's repositories; "public" takes an owner/name for any public repo. */
  mode: "mine" | "public";
  /** Already connected; shown as such and not offered again. */
  connected: ReadonlySet<string>;
  onClose: () => void;
  onConnected: (repo: ConnectedRepo) => void;
}

type Loaded<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; value: T };

/** Connect a repository: pick it from GitHub, see its merged-PR count, confirm. */
export function ConnectRepoSheet({
  org,
  mode,
  connected,
  onClose,
  onConnected,
}: ConnectRepoSheetProps) {
  const [repos, setRepos] = React.useState<Loaded<Repo[]>>({ status: "loading" });
  const [query, setQuery] = React.useState("");
  const [selected, setSelected] = React.useState<Repo | null>(null);
  const [detail, setDetail] = React.useState<Loaded<RepoDetail> | null>(null);
  const [submit, setSubmit] = React.useState<{ busy: boolean; error?: string }>({ busy: false });
  const search = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (mode !== "mine") return;
    let cancelled = false;
    setRepos({ status: "loading" });
    fetchGitHubRepos(org.login).then(
      (value) => !cancelled && setRepos({ status: "ok", value }),
      (error: Error) => !cancelled && setRepos({ status: "error", message: error.message }),
    );
    return () => {
      cancelled = true;
    };
  }, [org.login, mode]);

  React.useEffect(() => {
    search.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const choose = (repo: Repo) => {
    setSelected(repo);
    setDetail({ status: "loading" });
    fetchGitHubRepoDetail(repo.fullName).then(
      (value) =>
        setDetail((current) => (current?.status === "loading" ? { status: "ok", value } : current)),
      (error: Error) => setDetail({ status: "error", message: error.message }),
    );
  };

  const typedName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(query.trim()) ? query.trim() : null;
  const lookup = () => {
    if (!typedName) return;
    setSelected(null);
    setDetail({ status: "loading" });
    fetchGitHubRepoDetail(typedName).then(
      (value) => {
        setSelected(value.repo);
        setDetail({ status: "ok", value });
      },
      (error: Error) => setDetail({ status: "error", message: error.message }),
    );
  };

  const connect = () => {
    if (!selected) return;
    setSubmit({ busy: true });
    connectRepo(org.login, selected.fullName).then(
      (repo) => {
        setSubmit({ busy: false });
        onConnected(repo);
      },
      (error: Error) => setSubmit({ busy: false, error: error.message }),
    );
  };

  const needle = query.trim().toLowerCase();
  const visible =
    mode === "mine" && repos.status === "ok"
      ? repos.value.filter((repo) => !needle || repo.fullName.toLowerCase().includes(needle))
      : [];

  return (
    <div
      className="sheet-overlay"
      onPointerDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <aside
        className="sheet-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-run-title"
      >
        <header className="sheet-head">
          <div>
            <div className="eyebrow">
              {mode === "mine" ? "Connect My Repo" : "Connect Public Repo"}
            </div>
            <h2 id="new-run-title">
              {mode === "mine" ? "Choose a Repository" : "Enter a Public Repository"}
            </h2>
            <p className="sheet-sub">
              {mode === "mine" ? (
                <>
                  Repositories in <span className="mono">{org.login}</span> that your GitHub account
                  can read.
                </>
              ) : (
                <>
                  Any public repository on GitHub, as <span className="mono">owner/name</span>.
                </>
              )}
            </p>
          </div>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Close
          </button>
        </header>
        {mode === "public" ? (
          <form
            className="sheet-lookup"
            onSubmit={(event) => {
              event.preventDefault();
              lookup();
            }}
          >
            <input
              ref={search}
              className="sheet-search"
              type="text"
              placeholder="owner/name"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Repository owner and name"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <button type="submit" className="btn-ghost" disabled={!typedName}>
              Look Up
            </button>
          </form>
        ) : (
          <input
            ref={search}
            className="sheet-search"
            type="search"
            placeholder="Search repositories"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search repositories"
          />
        )}
        <div className="repo-list" role="listbox" aria-label="Repositories">
          {mode === "mine" && repos.status === "loading" && (
            <p className="repo-note">Loading repositories…</p>
          )}
          {mode === "mine" && repos.status === "error" && (
            <p className="repo-note error">{repos.message}</p>
          )}
          {mode === "mine" && repos.status === "ok" && visible.length === 0 && (
            <p className="repo-note">
              {needle ? "No repositories match." : "No repositories here."}
            </p>
          )}
          {mode === "public" && detail?.status === "loading" && (
            <p className="repo-note">Looking up {typedName}…</p>
          )}
          {mode === "public" && detail?.status === "error" && (
            <p className="repo-note error">{detail.message}</p>
          )}
          {mode === "public" && !detail && (
            <p className="repo-note">
              Type the repository as it appears on GitHub, then look it up.
            </p>
          )}
          {visible.map((repo) => (
            <button
              type="button"
              key={repo.githubId}
              role="option"
              aria-selected={selected?.githubId === repo.githubId}
              disabled={connected.has(repo.fullName.toLowerCase())}
              className={`repo-row ${selected?.githubId === repo.githubId ? "selected" : ""}`}
              onClick={() => choose(repo)}
            >
              <span className="repo-name">{repo.name}</span>
              <span className="repo-meta">
                {connected.has(repo.fullName.toLowerCase()) && (
                  <span className="repo-badge connected">connected</span>
                )}
                {repo.private && <span className="repo-badge">private</span>}
                {repo.archived && <span className="repo-badge">archived</span>}
                {repo.language && <span>{repo.language}</span>}
                <span>{formatAgo(repo.pushedAt)}</span>
              </span>
            </button>
          ))}
        </div>
        {selected && (
          <footer className="sheet-foot">
            <div className="repo-detail">
              <div className="repo-detail-name mono">{selected.fullName}</div>
              <div className="repo-detail-line">
                <span className="mono">{selected.defaultBranch}</span>
                <span className="repo-detail-sep" aria-hidden="true">
                  ·
                </span>
                <span>{detailText(detail)}</span>
              </div>
              {submit.error && <div className="repo-detail-error">{submit.error}</div>}
            </div>
            <button type="button" className="btn-primary" disabled={submit.busy} onClick={connect}>
              {submit.busy ? "Connecting…" : "Connect"}
            </button>
          </footer>
        )}
      </aside>
    </div>
  );
}

function detailText(detail: Loaded<RepoDetail> | null): string {
  if (!detail || detail.status === "loading") return "counting merged pull requests…";
  if (detail.status === "error") return "could not count merged pull requests";
  const count = detail.value.mergedPullRequests;
  return `${count} merged pull request${count === 1 ? "" : "s"} in the last 12 months`;
}
