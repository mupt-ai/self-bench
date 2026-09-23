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
    <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
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
    <article className="panel group relative flex h-full min-h-40 flex-col transition-[border-color,box-shadow] hover:border-foreground/30 hover:shadow-[0_2px_4px_rgb(0_0_0/0.06),0_10px_24px_-8px_rgb(0_0_0/0.14)] has-[a:focus-visible]:border-foreground/40">
      <Link
        aria-label={`Open ${repo.fullName}`}
        className="absolute inset-0 z-0 focus-visible:outline-none!"
        to={`/repos/${repo.fullName}`}
      />
      <header className="pointer-events-none relative z-10 flex items-center gap-2.5 px-4 pt-4">
        <OwnerAvatar owner={repo.fullName.split("/")[0] ?? ""} />
        <h2 className="min-w-0 flex-1 truncate font-mono text-sm font-medium">{repo.fullName}</h2>
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
              className="pointer-events-auto -my-1 -mr-2 h-8 w-8 text-muted-foreground hover:text-foreground"
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
      <p className="pointer-events-none relative z-10 mt-2 flex items-center gap-x-2 truncate px-4 text-xs text-muted-foreground">
        <span className="font-mono">{repo.defaultBranch}</span>
        <span aria-hidden="true">·</span>
        <span>{repo.private ? "Private" : "Public"}</span>
        <span aria-hidden="true">·</span>
        <span>Connected {formatAgo(repo.connectedAt)}</span>
      </p>
      <dl className="pointer-events-none relative z-10 mt-auto grid grid-cols-3 border-t border-border">
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

function ConnectRepositoryCard({ onConnect }: { onConnect(): void }) {
  return (
    <button
      type="button"
      onClick={onConnect}
      aria-label="Connect a Repository"
      className="group flex h-full min-h-40 w-full flex-col items-center justify-center gap-2 border-[1.5px] border-dashed border-foreground/15 text-sm font-semibold text-muted-foreground transition-colors hover:border-foreground/35 hover:bg-foreground/[0.03] hover:text-foreground"
    >
      <Plus className="size-5" aria-hidden="true" />
      Connect a Repository
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
    <div className="flex flex-col gap-1 border-r border-border px-4 py-3 last:border-r-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-mono text-sm font-medium tabular-nums">
        {value === undefined ? (
          <Skeleton className="inline-block h-3.5 w-8 align-middle" />
        ) : (
          <span className={attention ? "text-brand-foreground" : "text-foreground"}>{value}</span>
        )}
      </dd>
    </div>
  );
}
