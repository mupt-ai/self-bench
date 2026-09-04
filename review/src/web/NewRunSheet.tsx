import React from "react";
import { fetchRepoDetail, fetchRepos, formatAgo, type Repo, type RepoDetail } from "./api";
import type { SiteOrg } from "./session";

export interface NewRunSheetProps {
  org: SiteOrg;
  onClose: () => void;
}

type Loaded<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; value: T };

/** Step one of a new run: choose the repository. Slides in from the right over the runs table. */
export function NewRunSheet({ org, onClose }: NewRunSheetProps) {
  const [repos, setRepos] = React.useState<Loaded<Repo[]>>({ status: "loading" });
  const [query, setQuery] = React.useState("");
  const [selected, setSelected] = React.useState<Repo | null>(null);
  const [detail, setDetail] = React.useState<Loaded<RepoDetail> | null>(null);
  const search = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    let cancelled = false;
    setRepos({ status: "loading" });
    fetchRepos(org.login).then(
      (value) => !cancelled && setRepos({ status: "ok", value }),
      (error: Error) => !cancelled && setRepos({ status: "error", message: error.message }),
    );
    return () => {
      cancelled = true;
    };
  }, [org.login]);

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
    fetchRepoDetail(repo.fullName).then(
      (value) =>
        setDetail((current) => (current?.status === "loading" ? { status: "ok", value } : current)),
      (error: Error) => setDetail({ status: "error", message: error.message }),
    );
  };

  const needle = query.trim().toLowerCase();
  const visible =
    repos.status === "ok"
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
            <div className="eyebrow">New run</div>
            <h2 id="new-run-title">Choose a repository</h2>
            <p className="sheet-sub">
              Repositories in <span className="mono">{org.login}</span> that your GitHub account can
              read.
            </p>
          </div>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Close
          </button>
        </header>
        <input
          ref={search}
          className="sheet-search"
          type="search"
          placeholder="Search repositories"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search repositories"
        />
        <div className="repo-list" role="listbox" aria-label="Repositories">
          {repos.status === "loading" && <p className="repo-note">Loading repositories…</p>}
          {repos.status === "error" && <p className="repo-note error">{repos.message}</p>}
          {repos.status === "ok" && visible.length === 0 && (
            <p className="repo-note">
              {needle ? "No repositories match." : "No repositories here."}
            </p>
          )}
          {visible.map((repo) => (
            <button
              type="button"
              key={repo.githubId}
              role="option"
              aria-selected={selected?.githubId === repo.githubId}
              className={`repo-row ${selected?.githubId === repo.githubId ? "selected" : ""}`}
              onClick={() => choose(repo)}
            >
              <span className="repo-name">{repo.name}</span>
              <span className="repo-meta">
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
            </div>
            <button
              type="button"
              className="btn-primary"
              disabled
              title="Counts and backend come next"
            >
              Continue
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
