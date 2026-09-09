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
import { EmptyState } from "./ui";

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
      className="fixed inset-0 z-20 flex justify-end bg-bg/70"
      onPointerDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <aside
        className="flex h-full w-full max-w-[520px] flex-col border-l border-line-strong bg-surface"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-run-title"
      >
        <header className="flex items-start justify-between gap-4 px-6 pt-6 pb-4 [&_h2]:mt-1.5 [&_h2]:font-sans [&_h2]:text-lg [&_h2]:leading-tight [&_h2]:font-semibold">
          <div>
            <div className="font-mono text-sm font-medium tracking-[0.14em] text-mint uppercase">
              {mode === "mine" ? "Connect My Repo" : "Connect Public Repo"}
            </div>
            <h2 id="new-run-title">
              {mode === "mine" ? "Choose a Repository" : "Enter a Public Repository"}
            </h2>
            <p className="mt-1.5 text-muted">
              {mode === "mine" ? (
                <>
                  Repositories in <span className="font-mono">{org.login}</span> that your GitHub
                  account can read.
                </>
              ) : (
                <>
                  Any public repository on GitHub, as <span className="font-mono">owner/name</span>.
                </>
              )}
            </p>
          </div>
          <button
            type="button"
            className="inline-flex min-h-9 items-center justify-center gap-2 px-3 font-sans text-sm text-muted hover:text-mint-bright disabled:opacity-40"
            onClick={onClose}
          >
            Close
          </button>
        </header>
        {mode === "public" ? (
          <form
            className="mx-6 mb-2 flex gap-2 [&_input]:m-0 [&_input]:flex-1"
            onSubmit={(event) => {
              event.preventDefault();
              lookup();
            }}
          >
            <input
              ref={search}
              className="mx-6 mb-2 h-10 min-w-0 border border-line-strong bg-bg px-3 font-mono text-base text-ink placeholder:text-dim focus:border-mint"
              type="text"
              placeholder="owner/name"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Repository Owner and Name"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <button
              type="submit"
              className="inline-flex min-h-9 items-center justify-center gap-2 px-3 font-sans text-sm text-muted hover:text-mint-bright disabled:opacity-40"
              disabled={!typedName}
            >
              Look Up
            </button>
          </form>
        ) : (
          <input
            ref={search}
            className="mx-6 mb-2 h-10 min-w-0 border border-line-strong bg-bg px-3 font-mono text-base text-ink placeholder:text-dim focus:border-mint"
            type="search"
            placeholder="Search Repositories"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search Repositories"
          />
        )}
        <div
          className="min-h-0 flex-1 overflow-y-auto px-6 pb-4"
          role="listbox"
          aria-label="Repositories"
        >
          {mode === "mine" && repos.status === "loading" && (
            <p className="py-4 text-muted">Loading repositories…</p>
          )}
          {mode === "mine" && repos.status === "error" && (
            <p className="py-4 text-muted mt-4 font-mono text-base leading-relaxed text-danger">
              {repos.message}
            </p>
          )}
          {mode === "mine" && repos.status === "ok" && visible.length === 0 && (
            <EmptyState>{needle ? "No repositories match." : "No repositories here."}</EmptyState>
          )}
          {mode === "public" && detail?.status === "loading" && (
            <p className="py-4 text-muted">Looking up {typedName}…</p>
          )}
          {mode === "public" && detail?.status === "error" && (
            <p className="py-4 text-muted mt-4 font-mono text-base leading-relaxed text-danger">
              {detail.message}
            </p>
          )}
          {mode === "public" && !detail && (
            <p className="py-4 text-muted">
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
              className={`flex w-full items-baseline justify-between gap-4 border border-transparent border-b-line px-3 py-2.5 text-left text-ink hover:bg-surface-2 disabled:cursor-default disabled:opacity-55 ${selected?.githubId === repo.githubId ? "border-mint bg-surface-2" : ""}`}
              onClick={() => choose(repo)}
            >
              <span className="truncate font-mono text-sm font-medium">{repo.name}</span>
              <span className="flex shrink-0 gap-2.5 font-mono text-sm text-dim">
                {connected.has(repo.fullName.toLowerCase()) && (
                  <span className="text-sm tracking-widest text-warning uppercase text-mint">
                    connected
                  </span>
                )}
                {repo.private && (
                  <span className="text-sm tracking-widest text-warning uppercase">private</span>
                )}
                {repo.archived && (
                  <span className="text-sm tracking-widest text-warning uppercase">archived</span>
                )}
                {repo.language && <span>{repo.language}</span>}
                <span>{formatAgo(repo.pushedAt)}</span>
              </span>
            </button>
          ))}
        </div>
        {selected && (
          <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-line bg-surface-2 px-6 py-4">
            <div className="min-w-0">
              <div className="text-sm text-ink font-mono">{selected.fullName}</div>
              <div className="mt-1 flex gap-2 text-sm text-muted">
                <span className="font-mono">{selected.defaultBranch}</span>
                <span className="text-line-strong" aria-hidden="true">
                  ·
                </span>
                <span>{detailText(detail)}</span>
              </div>
              {submit.error && (
                <div className="mt-1.5 font-mono text-sm text-danger">{submit.error}</div>
              )}
            </div>
            <button
              type="button"
              className="inline-flex h-9 shrink-0 items-center justify-center gap-2 border border-mint bg-mint px-4 font-sans text-sm font-bold text-bg hover:bg-mint-bright disabled:cursor-not-allowed disabled:opacity-40"
              disabled={submit.busy}
              onClick={connect}
            >
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
