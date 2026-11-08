import { Plus } from "lucide-react";
import React from "react";
import { useNavigate } from "react-router";
import {
  type ConnectedRepo,
  disconnectRepo,
  fetchConnectedRepos,
  fetchTaskCounts,
  type RepoTaskCounts,
} from "../api";
import { ConnectRepoSheet } from "../ConnectRepoSheet";
import {
  deleteGroup,
  type GroupList,
  type GroupView,
  groupRequest,
  groupsUrl,
} from "../groups/api";
import { GroupDialog } from "../groups/GroupDialog";
import { CardGridSkeleton } from "../LoadingSkeleton";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { Button, Notice, PageFrame, PageHeader } from "../ui";
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

/**
 * Mined Repos: the workspace's connected repositories and its groups, in one list. A group is
 * evaluated like one repository over all its members' approved tasks.
 */
export function ReposPage() {
  const { org } = useOrg();
  const navigate = useNavigate();
  useDocumentTitle(`${org.login} · SelfBench`);
  const [repos, setRepos] = React.useState<Repos>({ status: "loading" });
  const [groups, setGroups] = React.useState<GroupList>();
  const [error, setError] = React.useState<string | null>(null);
  const [connecting, setConnecting] = React.useState<"mine" | "public" | null>(null);
  const [creatingGroup, setCreatingGroup] = React.useState(false);
  const [stats, setStats] = React.useState<Record<string, RepoStats>>({});
  // Each groups request supersedes the ones before it, so a slow earlier response can't overwrite a later one.
  const groupsSeq = React.useRef(0);
  const loadGroups = React.useCallback((login: string) => {
    const seq = ++groupsSeq.current;
    groupRequest<GroupList>(groupsUrl(login)).then(
      (next) => seq === groupsSeq.current && setGroups(next),
      (cause: Error) => seq === groupsSeq.current && setError(cause.message),
    );
  }, []);
  // Reloads the groups after a change here, so the cards and the New Group picker stay current.
  const reloadGroups = React.useCallback(() => loadGroups(org.login), [loadGroups, org.login]);
  React.useEffect(() => {
    let cancelled = false;
    setGroups(undefined);
    loadGroups(org.login);
    // Invalidates the groups request in flight when the org changes.
    const invalidate = () => {
      groupsSeq.current++;
    };
    fetchConnectedRepos(org.login).then(
      (found) => {
        if (cancelled) return;
        // Evals have their own page.
        setRepos({ status: "ok", repos: found.filter((repo) => repo.kind !== "eval") });
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
      invalidate();
    };
  }, [org.login, loadGroups]);

  const closeSheet = React.useCallback(() => setConnecting(null), []);
  const onConnected = React.useCallback(
    (repo: ConnectedRepo) => {
      setRepos((current) =>
        current.status === "ok" ? { status: "ok", repos: [repo, ...current.repos] } : current,
      );
      setConnecting(null);
      void reloadGroups();
    },
    [reloadGroups],
  );
  const disconnect = (repo: ConnectedRepo) => {
    if (!window.confirm(`Disconnect ${repo.fullName}?`)) return;
    disconnectRepo(org.login, repo.fullName).then(
      () => {
        setRepos((current) =>
          current.status === "ok"
            ? { status: "ok", repos: current.repos.filter((r) => r.fullName !== repo.fullName) }
            : current,
        );
        void reloadGroups();
      },
      (cause: Error) => setError(cause.message),
    );
  };
  const removeGroup = (group: GroupView) =>
    deleteGroup(org.login, group).then(
      (deleted) => deleted && void reloadGroups(),
      (cause: Error) => setError(cause.message),
    );
  const connected = new Set(
    repos.status === "ok" ? repos.repos.map((r) => r.fullName.toLowerCase()) : [],
  );

  return (
    <PageFrame>
      <PageHeader
        title="Connected Repositories"
        description={`Repositories available to ${org.login}.`}
      >
        <Button size="small" onClick={() => setConnecting("public")}>
          <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
          Connect Public Repo
        </Button>
        <Button size="small" variant="primary" onClick={() => setConnecting("mine")}>
          <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
          Connect My Repo
        </Button>
      </PageHeader>
      {error && <Notice className="mb-4">{error}</Notice>}
      {repos.status === "loading" && !error && <CardGridSkeleton label="Loading Repositories" />}
      {repos.status === "ok" && (
        <RepositoryList
          repos={repos.repos}
          stats={stats}
          groups={groups?.groups ?? []}
          onDisconnect={disconnect}
          onRemoveGroup={removeGroup}
          onConnect={() => setConnecting("mine")}
          // The picker needs the groups' repository list, so New Group waits for it to load.
          onNewGroup={groups ? () => setCreatingGroup(true) : undefined}
        />
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
      {creatingGroup && groups && (
        <GroupDialog
          org={org.login}
          repositories={groups.repositories}
          onClose={() => setCreatingGroup(false)}
          onSaved={(group) => navigate(`/groups/${group.slug}`)}
        />
      )}
    </PageFrame>
  );
}
