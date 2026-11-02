import { type ConnectedRepo, formatAgo } from "../api";
import { AddScopeButton, ScopeCard } from "../ScopeCard";

export interface RepoStats {
  tasks: number;
  needsReview: number;
  lastPr?: number;
}

export function RepositoryList({
  repos,
  stats,
  onDisconnect,
  onConnect,
}: {
  repos: ConnectedRepo[];
  stats: Record<string, RepoStats>;
  onDisconnect(repo: ConnectedRepo): void;
  onConnect(): void;
}) {
  return (
    <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {repos.map((repo) => (
        <li key={repo.fullName}>
          <RepositoryCard repo={repo} stats={stats[repo.fullName]} onDisconnect={onDisconnect} />
        </li>
      ))}
      <li>
        <AddScopeButton label="Connect a Repository" onClick={onConnect} />
      </li>
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
