import { Clock3, KeyRound, ShieldCheck } from "lucide-react";
import { formatAgo } from "../api";
import { Skeleton } from "../LoadingSkeleton";
import { Button, EmptyState, SectionHeader } from "../ui";
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
      <SectionHeader
        title={
          <span className="flex items-center gap-2">
            <span id="active-api-keys-title">Active Keys</span>
            {keys && (
              <span className="border border-border px-1.5 py-0.5 font-mono text-[10px] leading-4 text-muted-foreground">
                {keys.length}
              </span>
            )}
          </span>
        }
        description="Keys act as you and stop working as soon as you revoke them."
      />
      {loading ? (
        <ApiKeyListSkeleton />
      ) : !keys?.length ? (
        <EmptyState title="No API Keys Yet">
          Create a key to give scripts access to your workspaces. The full secret is shown once.
        </EmptyState>
      ) : (
        <div className="overflow-x-auto border border-border bg-card">
          <table className="w-full min-w-[640px] border-collapse text-left text-sm">
            <thead className="bg-muted/50 text-[10px] tracking-wider text-muted-foreground uppercase">
              <tr>
                <th className="px-4 py-3 font-medium">Key</th>
                <th className="px-4 py-3 font-medium">Scope</th>
                <th className="px-4 py-3 font-medium">Last Used</th>
                <th className="px-4 py-3 font-medium">Created</th>
                <th className="px-4 py-3">
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
    <tr className="transition-colors hover:bg-muted/20" data-testid="api-key-card">
      <td className="px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <KeyRound className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="max-w-64 truncate font-medium text-foreground" title={apiKey.name}>
                {apiKey.name}
              </span>
              <span className="border border-success/30 px-1.5 py-0.5 text-[9px] leading-3 text-success uppercase">
                Active
              </span>
            </div>
            <code className="mt-1 block font-mono text-xs text-muted-foreground">
              {apiKey.prefix}…
            </code>
          </div>
        </div>
      </td>
      <td className="px-4 py-3">
        <span className="inline-flex items-center gap-1.5 text-xs text-foreground">
          <ShieldCheck className="size-3.5 text-muted-foreground" aria-hidden="true" />
          {scopeLabels[apiKey.scope]}
        </span>
      </td>
      <td className="px-4 py-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Clock3 className="size-3.5" aria-hidden="true" />
          {apiKey.lastUsedAt ? formatAgo(apiKey.lastUsedAt) : "Never Used"}
        </span>
      </td>
      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
        {apiKey.createdAt.slice(0, 10)}
      </td>
      <td className="px-4 py-3 text-right">
        <Button
          size="small"
          variant="ghost"
          onClick={onRevoke}
          aria-label={`Revoke ${apiKey.name}`}
          className="text-destructive hover:bg-destructive/[0.06] hover:text-destructive"
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
