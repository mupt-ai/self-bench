import { type ConnectedRepo, formatAgo } from "../api";
import type { GroupView } from "../groups/api";
import { GroupCard } from "../groups/GroupCard";
import { AddScopeButton, ScopeCard } from "../ScopeCard";

export interface RepoStats {
  tasks: number;
  needsReview: number;
  lastPr?: number;
}

export function RepositoryList({
  repos,
  stats,
  groups,
  onDisconnect,
  onRemoveGroup,
  onConnect,
  onNewGroup,
}: {
  repos: ConnectedRepo[];
  stats: Record<string, RepoStats>;
  groups: GroupView[];
  onDisconnect(repo: ConnectedRepo): void;
  onRemoveGroup(group: GroupView): void;
  onConnect(): void;
  /** Absent until the groups have loaded, since a group is picked from the repositories they hold. */
  onNewGroup?: () => void;
}) {
  return (
    <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {groups.map((group) => (
        <li key={`group:${group.slug}`}>
          <GroupCard group={group} onRemove={() => onRemoveGroup(group)} />
        </li>
      ))}
      {repos.map((repo) => (
        <li key={repo.fullName}>
          <RepositoryCard repo={repo} stats={stats[repo.fullName]} onDisconnect={onDisconnect} />
        </li>
      ))}
      <li>
        <AddScopeButton label="Connect a Repository" onClick={onConnect} />
      </li>
      {onNewGroup && (
        <li>
          <AddScopeButton label="New Group" onClick={onNewGroup} />
        </li>
      )}
    </ul>
  );
}

function RepositoryCard({
  repo,
  stats,
  onDisconnect,
}: {
  repo: ConnectedRepo;
  stats?: RepoStats;
  onDisconnect(repo: ConnectedRepo): void;
}) {
  return (
    <ScopeCard
      name={repo.fullName}
      to={`/repos/${repo.fullName}`}
      icon={<OwnerAvatar owner={repo.fullName.split("/")[0] ?? ""} />}
      details={[
        <span key="branch" className="font-mono">
          {repo.defaultBranch}
        </span>,
        repo.private ? "Private" : "Public",
        `Connected ${formatAgo(repo.connectedAt)}`,
      ]}
      stats={[
        { label: "Tasks", value: stats?.tasks },
        { label: "Needs Review", value: stats?.needsReview, attention: !!stats?.needsReview },
        { label: "Last PR", value: stats ? (stats.lastPr ? `#${stats.lastPr}` : "—") : undefined },
      ]}
      removeLabel="Disconnect"
      onRemove={() => onDisconnect(repo)}
    />
  );
}

function OwnerAvatar({ owner }: { owner: string }) {
  return (
    <img
      src={`https://github.com/${encodeURIComponent(owner)}.png?size=48`}
      alt=""
      width={24}
      height={24}
      loading="lazy"
      className="avatar size-6 shrink-0 rounded-full bg-muted object-contain"
    />
  );
}
