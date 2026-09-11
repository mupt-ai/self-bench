import { Plus } from "lucide-react";
import React from "react";
import {
  type ConnectedRepo,
  disconnectRepo,
  fetchConnectedRepos,
  fetchTaskCounts,
  type RepoTaskCounts,
} from "../api";
import { ConnectRepoSheet } from "../ConnectRepoSheet";
import { ListSkeleton } from "../LoadingSkeleton";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { Button, EmptyState, Notice, PageFrame, PageHeader } from "../ui";
import { type RepoStats, RepositoryList } from "./RepositoryList";

type Repos = { status: "loading" } | { status: "ok"; repos: ConnectedRepo[] };

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
    <PageFrame>
      <PageHeader
        title="Connected Repositories"
        description={`Repositories available to ${org.login}.`}
      >
        <Button onClick={() => setConnecting("public")}>
          <Plus aria-hidden="true" />
          Connect Public Repo
        </Button>
        <Button variant="primary" onClick={() => setConnecting("mine")}>
          <Plus aria-hidden="true" />
          Connect My Repo
        </Button>
      </PageHeader>
      {error && <Notice className="mb-4">{error}</Notice>}
      {repos.status === "loading" && !error && <ListSkeleton label="Loading Repositories" />}
      {repos.status === "ok" && repos.repos.length === 0 && (
        <EmptyState title="Connect a Repository to Get Started">
          Choose a repository to turn merged pull requests into reviewable tasks.
        </EmptyState>
      )}
      {repos.status === "ok" && repos.repos.length > 0 && (
        <RepositoryList repos={repos.repos} stats={stats} onDisconnect={disconnect} />
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
    </PageFrame>
  );
}
