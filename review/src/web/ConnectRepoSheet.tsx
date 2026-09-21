import React from "react";
import {
  type ConnectedRepo,
  connectRepo,
  fetchGitHubRepoDetail,
  fetchGitHubRepos,
  type Repo,
} from "./api";
import { Dialog, DialogHeader } from "./Dialog";
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

/** Connect a repository from the org list or a public owner/name lookup. */
export function ConnectRepoSheet({
  org,
  mode,
  connected,
  onClose,
  onConnected,
}: ConnectRepoSheetProps) {
  const [repos, setRepos] = React.useState<Loaded<Repo[]>>({ status: "loading" });
  const [query, setQuery] = React.useState("");
  const [publicRepo, setPublicRepo] = React.useState<Loaded<Repo> | null>(null);
  const [submit, setSubmit] = React.useState<{ busy: boolean; error?: string; fullName?: string }>({
    busy: false,
  });
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

  const typedName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(query.trim()) ? query.trim() : null;
  const lookup = () => {
    if (!typedName) return;
    setPublicRepo({ status: "loading" });
    fetchGitHubRepoDetail(typedName).then(
      (value) => setPublicRepo({ status: "ok", value: value.repo }),
      (error: Error) => setPublicRepo({ status: "error", message: error.message }),
    );
  };

  const connect = (repo: Repo) => {
    setSubmit({ busy: true, fullName: repo.fullName });
    connectRepo(org.login, repo.fullName).then(
      (connectedRepo) => {
        setSubmit({ busy: false });
        onConnected(connectedRepo);
      },
      (error: Error) => setSubmit({ busy: false, error: error.message, fullName: repo.fullName }),
    );
  };

  const needle = query.trim().toLowerCase();
  const visible =
    mode === "mine" && repos.status === "ok"
      ? repos.value.filter((repo) => !needle || repo.fullName.toLowerCase().includes(needle))
      : publicRepo?.status === "ok"
        ? [publicRepo.value]
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
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 pb-4 sm:px-6 sm:pb-6">
          {submit.error && <Notice className="mb-4">{submit.error}</Notice>}
          {mode === "mine" && repos.status === "loading" && (
            <ListSkeleton label="Loading Repositories" />
          )}
          {mode === "mine" && repos.status === "error" && <Notice>{repos.message}</Notice>}
          {mode === "mine" && repos.status === "ok" && visible.length === 0 && (
            <EmptyState title={needle ? "No Matching Repositories" : "No Repositories"}>
              Try another search or connect a public repository.
            </EmptyState>
          )}
          {mode === "public" && publicRepo?.status === "loading" && (
            <ListSkeleton label="Looking Up Repository" rows={1} />
          )}
          {mode === "public" && publicRepo?.status === "error" && (
            <Notice>{publicRepo.message}</Notice>
          )}
          {mode === "public" && !publicRepo && (
            <p className="py-4 text-sm text-muted-foreground">
              Type the repository as it appears on GitHub, then look it up.
            </p>
          )}
          {visible.length > 0 && (
            <ul className="border border-border bg-card" aria-label="Repositories">
              {visible.map((repo) => (
                <li key={repo.githubId} className="border-t border-border first:border-t-0">
                  <RepoRow
                    repo={repo}
                    connected={connected.has(repo.fullName.toLowerCase())}
                    busy={submit.busy}
                    connecting={submit.busy && submit.fullName === repo.fullName}
                    onConnect={connect}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function RepoRow({
  repo,
  connected,
  busy,
  connecting,
  onConnect,
}: {
  repo: Repo;
  connected: boolean;
  busy: boolean;
  connecting: boolean;
  onConnect: (repo: Repo) => void;
}) {
  const meta = [
    repo.defaultBranch,
    repo.private ? "Private" : undefined,
    repo.archived ? "Archived" : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div
      className="flex items-center justify-between gap-4 px-4 py-4"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="min-w-0">
        <p className="truncate text-sm text-foreground">{repo.fullName}</p>
        <p className="mt-1 truncate text-xs text-muted-foreground">{meta}</p>
      </div>
      {connected ? (
        <span className="shrink-0 text-xs tracking-wide text-muted-foreground uppercase">
          Connected
        </span>
      ) : (
        <Button
          variant="primary"
          className="shrink-0"
          disabled={busy}
          onClick={() => onConnect(repo)}
        >
          {connecting ? "Connecting…" : "Connect"}
        </Button>
      )}
    </div>
  );
}
