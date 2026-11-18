import { Clock3, KeyRound, ShieldCheck } from "lucide-react";
import { formatAgo } from "../api";
import { GhostKeys } from "../ghosts";
import { Skeleton } from "../LoadingSkeleton";
import { InfoTooltip } from "../primitives/tooltip";
import { Button, badgeStyles, chipStyles, EmptyState } from "../ui";
import { type ApiKey, scopeLabels } from "./api-keys";

export function ApiKeyList({
  keys,
  loading,
  onRevoke,
}: {
  keys: ApiKey[] | undefined;
  loading: boolean;
  onRevoke(key: ApiKey): void;
}) {
  return (
    <section aria-labelledby="active-api-keys-title">
      <header className="mb-3 flex items-center gap-2">
        <h2 id="active-api-keys-title" className="text-base leading-6 font-medium text-foreground">
          Active Keys
        </h2>
        {keys && <span className={`${chipStyles} tabular-nums`}>{keys.length}</span>}
        <InfoTooltip label="Keys act as you and stop working as soon as you revoke them." />
      </header>
      {loading ? (
        <ApiKeyListSkeleton />
      ) : !keys?.length ? (
        <EmptyState title="No API Keys Yet" visual={<GhostKeys />}>
          Create a key to give scripts access to your workspaces. The full secret is shown once.
        </EmptyState>
      ) : (
        <div className="overflow-x-auto border border-border bg-card">
          <table className="w-full min-w-[640px] border-collapse text-left text-sm">
            <thead className="text-xs text-faint">
              <tr>
                <th className="px-4 py-2.5 font-medium">Key</th>
                <th className="px-4 py-2.5 font-medium">Scope</th>
                <th className="px-4 py-2.5 font-medium">Last Used</th>
                <th className="px-4 py-2.5 font-medium">Created</th>
                <th className="px-4 py-2.5">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {keys.map((key) => (
                <ApiKeyRow key={key.id} apiKey={key} onRevoke={() => onRevoke(key)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ApiKeyRow({ apiKey, onRevoke }: { apiKey: ApiKey; onRevoke(): void }) {
  return (
    <tr className="transition-colors hover:bg-accent" data-testid="api-key-card">
      <td className="px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-3">
          <KeyRound className="size-4 shrink-0 text-faint" aria-hidden="true" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="max-w-64 truncate font-medium text-foreground" title={apiKey.name}>
                {apiKey.name}
              </span>
              <span className={`${badgeStyles} border-brand/40 bg-brand/10 text-brand`}>
                Active
              </span>
            </div>
            <code className="mt-1 block font-mono text-xs text-muted-foreground">
              {apiKey.prefix}…
            </code>
          </div>
        </div>
      </td>
      <td className="px-4 py-2.5">
        <span className="inline-flex items-center gap-1.5 text-xs text-foreground">
          <ShieldCheck className="size-3.5 text-faint" aria-hidden="true" />
          {scopeLabels[apiKey.scope]}
        </span>
      </td>
      <td className="px-4 py-2.5 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Clock3 className="size-3.5 text-faint" aria-hidden="true" />
          {apiKey.lastUsedAt ? formatAgo(apiKey.lastUsedAt) : "Never Used"}
        </span>
      </td>
      <td className="px-4 py-2.5 text-xs tabular-nums text-muted-foreground">
        {apiKey.createdAt.slice(0, 10)}
      </td>
      <td className="px-4 py-2.5 text-right">
        <Button
          size="small"
          variant="ghost"
          onClick={onRevoke}
          aria-label={`Revoke ${apiKey.name}`}
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          Revoke
        </Button>
      </td>
    </tr>
  );
}

function ApiKeyListSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading API Keys"
      className="divide-y divide-border border border-border bg-card"
    >
      <span className="sr-only">Loading API keys…</span>
      {["first", "second", "third"].map((key) => (
        <div key={key} className="flex items-center gap-4 px-4 py-3">
          <div className="min-w-0 flex-1">
            <Skeleton className="h-4 w-36 max-w-full" />
            <Skeleton className="mt-2 h-3 w-28 max-w-full" />
          </div>
          <Skeleton className="h-4 w-24" />
          <Skeleton className="hidden h-4 w-20 sm:block" />
          <Skeleton className="h-8 w-16" />
        </div>
      ))}
    </div>
  );
}
