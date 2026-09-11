import { FolderGit2, Unplug } from "lucide-react";
import { Link } from "react-router";
import { type ConnectedRepo, formatAgo } from "../api";
import { Skeleton } from "../LoadingSkeleton";
import { Button } from "../ui";

export interface RepoStats {
  tasks: number;
  needsReview: number;
  lastPr?: number;
}
const columns =
  "grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-3 md:grid-cols-[minmax(0,1fr)_5rem_8rem_5rem_2.25rem]";

export function RepositoryList({
  repos,
  stats,
  onDisconnect,
}: {
  repos: ConnectedRepo[];
  stats: Record<string, RepoStats>;
  onDisconnect(repo: ConnectedRepo): void;
}) {
  return (
    <div className="overflow-hidden border border-border bg-card">
      <div
        className={`${columns} hidden border-b border-border bg-muted/50 px-4 py-3 text-xs tracking-wider text-muted-foreground uppercase md:grid`}
        aria-hidden="true"
      >
        <span>Repository</span>
        <span>Tasks</span>
        <span>Needs Review</span>
        <span>Last PR</span>
        <span />
      </div>
      <ul className="divide-y divide-border">
        {repos.map((repo) => {
          const values = stats[repo.fullName];
          return (
            <li
              key={repo.fullName}
              className={`${columns} items-center px-4 py-4 transition-colors hover:bg-muted/40`}
            >
              <div className="min-w-0">
                <Link
                  className="inline-flex max-w-full items-center gap-2 font-medium text-foreground hover:text-brand"
                  to={`/repos/${repo.fullName}`}
                >
                  <FolderGit2
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span className="truncate">{repo.fullName}</span>
                </Link>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {repo.defaultBranch} · {repo.private ? "Private" : "Public"} · connected{" "}
                  {formatAgo(repo.connectedAt)}
                </p>
              </div>
              <div className="col-span-2 grid grid-cols-3 gap-4 text-sm tabular-nums md:contents">
                <Stat label="Tasks" value={values?.tasks} />
                <Stat
                  label="Needs Review"
                  value={values?.needsReview}
                  attention={!!values?.needsReview}
                />
                <Stat
                  label="Last PR"
                  value={values ? (values.lastPr ? `#${values.lastPr}` : "—") : undefined}
                />
              </div>
              <Button
                size="icon"
                variant="ghost"
                className="col-start-2 row-start-1 text-muted-foreground hover:text-destructive md:col-start-5"
                aria-label={`Disconnect ${repo.fullName}`}
                title="Disconnect"
                onClick={() => onDisconnect(repo)}
              >
                <Unplug aria-hidden="true" />
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
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
      <span className="mb-1 block text-xs text-muted-foreground md:sr-only">{label}</span>
      {value === undefined ? (
        <Skeleton className="h-4 w-8" />
      ) : (
        <span className={attention ? "text-brand" : "text-foreground"}>{value}</span>
      )}
    </div>
  );
}
