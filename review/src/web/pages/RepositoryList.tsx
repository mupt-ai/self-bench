import { Ellipsis, Plus } from "lucide-react";
import { useRef } from "react";
import { Link } from "react-router";
import { type ConnectedRepo, formatAgo } from "../api";
import { Skeleton } from "../LoadingSkeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../primitives/dropdown-menu";
import { Button } from "../ui";

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
    <ul className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {repos.map((repo) => (
        <li key={repo.fullName}>
          <RepositoryCard repo={repo} stats={stats[repo.fullName]} onDisconnect={onDisconnect} />
        </li>
      ))}
      <li>
        <ConnectRepositoryCard onConnect={onConnect} />
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
  const trigger = useRef<HTMLButtonElement>(null);
  const pendingDisconnect = useRef(false);
  return (
    <article className="group relative flex h-full min-h-36 flex-col border border-border bg-card transition-colors hover:border-brand hover:[&_[data-card-title]]:text-brand">
      <Link
        aria-label={`Open ${repo.fullName}`}
        className="absolute inset-0 z-0"
        to={`/repos/${repo.fullName}`}
      />
      <header className="pointer-events-none relative z-10 flex items-start justify-between gap-2 p-4 pb-3">
        <div className="min-w-0">
          <h2
            data-card-title
            className="truncate text-sm leading-snug font-medium transition-colors"
          >
            {repo.fullName}
          </h2>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {repo.defaultBranch} · {repo.private ? "Private" : "Public"} · connected{" "}
            {formatAgo(repo.connectedAt)}
          </p>
        </div>
        <DropdownMenu
          onOpenChange={(open) => {
            if (open) pendingDisconnect.current = false;
          }}
        >
          <DropdownMenuTrigger asChild>
            <Button
              ref={trigger}
              size="icon"
              variant="ghost"
              className="pointer-events-auto -mt-1 -mr-1 h-8 w-8 text-muted-foreground hover:text-foreground"
              aria-label={`Actions for ${repo.fullName}`}
            >
              <Ellipsis aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            onCloseAutoFocus={(event) => {
              if (!pendingDisconnect.current) return;
              event.preventDefault();
              pendingDisconnect.current = false;
              trigger.current?.focus();
              onDisconnect(repo);
            }}
          >
            <DropdownMenuItem
              className="text-destructive data-[highlighted]:text-destructive"
              onSelect={() => {
                pendingDisconnect.current = true;
              }}
            >
              Disconnect
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      <dl className="pointer-events-none relative z-10 flex flex-col gap-1 p-4 pt-0 text-xs text-muted-foreground">
        <Stat label="Tasks" value={stats?.tasks} />
        <Stat label="Needs Review" value={stats?.needsReview} attention={!!stats?.needsReview} />
        <Stat
          label="Last PR"
          value={stats ? (stats.lastPr ? `#${stats.lastPr}` : "—") : undefined}
        />
      </dl>
    </article>
  );
}

function ConnectRepositoryCard({ onConnect }: { onConnect(): void }) {
  return (
    <button
      type="button"
      onClick={onConnect}
      aria-label="Connect a Repository"
      className="group flex h-full min-h-36 w-full flex-col items-center justify-center border border-dashed border-border transition-colors hover:border-brand hover:bg-muted/20"
    >
      <Plus className="h-6 w-6 text-muted-foreground group-hover:text-brand" aria-hidden="true" />
    </button>
  );
}

function Stat({
  label,
  value,
  attention,
}: {
  label: string;
  value?: number | string;
  attention?: boolean;
}) {
  return (
    <div>
      <dt className="inline uppercase tracking-widest">{label}</dt>{" "}
      <dd className="inline tabular-nums">
        {value === undefined ? (
          <Skeleton className="inline-block h-3 w-8 align-middle" />
        ) : (
          <span className={attention ? "text-brand" : "text-foreground"}>{value}</span>
        )}
      </dd>
    </div>
  );
}
