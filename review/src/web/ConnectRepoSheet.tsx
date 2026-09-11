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
import { Dialog, DialogFooter, DialogHeader } from "./Dialog";
import { ListSkeleton } from "./LoadingSkeleton";
import type { SiteOrg } from "./session";
import { Button, EmptyState, Input, Notice, SearchInput } from "./ui";

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
    <Dialog
      initialFocus={search}
      onDismiss={onClose}
      busy={submit.busy}
      placement="right"
      size="large"
      aria-labelledby="connect-repo-title"
    >
      <div className="flex h-full flex-col">
        <DialogHeader
          title={mode === "mine" ? "Connect My Repo" : "Connect Public Repo"}
          titleId="connect-repo-title"
          description={
            mode === "mine"
              ? `Repositories in ${org.login} that your GitHub account can read.`
              : "Find a public GitHub repository by owner/name."
          }
          onClose={onClose}
          busy={submit.busy}
        />
        {mode === "public" ? (
          <form
            className="flex gap-2 p-4 sm:p-6"
            onSubmit={(event) => {
              event.preventDefault();
              lookup();
            }}
          >
            <Input
              ref={search}
              className="flex-1"
              type="text"
              placeholder="owner/name"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Repository Owner and Name"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <Button type="submit" disabled={!typedName}>
              Look Up
            </Button>
          </form>
        ) : (
          <SearchInput
            ref={search}
            className="m-4 sm:m-6"
            type="search"
            placeholder="Search Repositories"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search Repositories"
          />
        )}
        <fieldset
          className="min-h-0 min-w-0 flex-1 overflow-y-auto border-0 px-4 pb-4 sm:px-6 sm:pb-6"
          aria-label="Repositories"
        >
          {mode === "mine" && repos.status === "loading" && (
            <ListSkeleton label="Loading Repositories" />
          )}
          {mode === "mine" && repos.status === "error" && <Notice>{repos.message}</Notice>}
          {mode === "mine" && repos.status === "ok" && visible.length === 0 && (
            <EmptyState title={needle ? "No Matching Repositories" : "No Repositories"}>
              Try another search or connect a public repository.
            </EmptyState>
          )}
          {mode === "public" && detail?.status === "loading" && (
            <ListSkeleton label="Looking Up Repository" rows={1} />
          )}
          {mode === "public" && detail?.status === "error" && <Notice>{detail.message}</Notice>}
          {mode === "public" && !detail && (
            <p className="py-4 text-muted-foreground">
              Type the repository as it appears on GitHub, then look it up.
            </p>
          )}
          {visible.map((repo) => (
            <button
              type="button"
              key={repo.githubId}
              aria-pressed={selected?.githubId === repo.githubId}
              disabled={connected.has(repo.fullName.toLowerCase())}
              className={`flex w-full flex-wrap items-center justify-between gap-2 border border-transparent border-b-border px-3 py-2.5 text-left text-foreground hover:bg-muted disabled:cursor-default disabled:opacity-55 ${selected?.githubId === repo.githubId ? "border-brand bg-muted" : ""}`}
              onClick={() => choose(repo)}
            >
              <span className="truncate font-mono text-sm font-medium">{repo.name}</span>
              <span className="flex max-w-full flex-wrap gap-2 text-xs text-muted-foreground">
                {connected.has(repo.fullName.toLowerCase()) && (
                  <span className="text-[10px] tracking-wide text-muted-foreground uppercase">
                    Connected
                  </span>
                )}
                {repo.private && (
                  <span className="text-[10px] tracking-wide text-muted-foreground uppercase">
                    Private
                  </span>
                )}
                {repo.archived && (
                  <span className="text-[10px] tracking-wide text-muted-foreground uppercase">
                    Archived
                  </span>
                )}
                {repo.language && <span>{repo.language}</span>}
                <span>{formatAgo(repo.pushedAt)}</span>
              </span>
            </button>
          ))}
        </fieldset>
        {selected && (
          <DialogFooter className="justify-between">
            <div className="min-w-0">
              <div className="text-sm text-foreground font-mono">{selected.fullName}</div>
              <div className="mt-1 flex gap-2 text-sm text-muted-foreground">
                <span className="font-mono">{selected.defaultBranch}</span>
                <span className="text-input" aria-hidden="true">
                  ·
                </span>
                <span>{detailText(detail)}</span>
              </div>
              {submit.error && (
                <div className="mt-1.5 font-mono text-sm text-destructive">{submit.error}</div>
              )}
            </div>
            <Button variant="primary" disabled={submit.busy} onClick={connect}>
              {submit.busy ? "Connecting…" : "Connect"}
            </Button>
          </DialogFooter>
        )}
      </div>
    </Dialog>
  );
}

function detailText(detail: Loaded<RepoDetail> | null): string {
  if (!detail || detail.status === "loading") return "counting merged pull requests…";
  if (detail.status === "error") return "could not count merged pull requests";
  const count = detail.value.mergedPullRequests;
  return `${count} merged pull request${count === 1 ? "" : "s"} in the last 12 months`;
}
