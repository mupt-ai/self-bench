import { Clock3, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
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
          <>
            <span id="active-api-keys-title">Active Keys</span>
            {keys && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">{keys.length}</span>
            )}
          </>
        }
        description="Only active keys are listed. Revoked keys stop working immediately."
      />
      {loading ? (
        <ApiKeyListSkeleton />
      ) : !keys?.length ? (
        <EmptyState title="No API Keys Yet">
          Create a key, then send it as <code className="font-mono">Authorization: Bearer</code> or{" "}
          <code className="font-mono">X-API-Key</code> with your requests.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border border border-border bg-card">
          {keys.map((key) => (
            <ApiKeyCard key={key.id} apiKey={key} onRevoke={() => onRevoke(key)} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ApiKeyCard({ apiKey, onRevoke }: { apiKey: ApiKey; onRevoke(): void }) {
  return (
    <li className="p-4 transition-colors hover:bg-muted/20" data-testid="api-key-card">
      <div className="flex flex-col gap-4 md:flex-row md:items-center">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h3 className="truncate text-sm font-medium" title={apiKey.name}>
              {apiKey.name}
            </h3>
            <span className="inline-flex items-center gap-1.5 text-[10px] tracking-wider text-success uppercase">
              <span className="size-1 bg-success" aria-hidden="true" />
              Active
            </span>
          </div>
          <code className="mt-1 block text-xs text-muted-foreground">{apiKey.prefix}…</code>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-xs sm:grid-cols-3 md:w-[28rem]">
          <KeyDetail icon={<ShieldCheck />} label="Scope" value={scopeLabels[apiKey.scope]} />
          <KeyDetail
            icon={<Clock3 />}
            label="Last Used"
            value={apiKey.lastUsedAt ? formatAgo(apiKey.lastUsedAt) : "Never Used"}
          />
          <KeyDetail label="Created" value={apiKey.createdAt.slice(0, 10)} />
        </dl>
        <Button
          size="small"
          variant="ghost"
          onClick={onRevoke}
          aria-label={`Revoke ${apiKey.name}`}
          className="self-start text-destructive hover:text-destructive md:self-center"
        >
          Revoke
        </Button>
      </div>
    </li>
  );
}

function KeyDetail({ icon, label, value }: { icon?: ReactNode; label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1.5 text-[10px] tracking-wider text-muted-foreground uppercase [&_svg]:size-3">
        {icon && <span aria-hidden="true">{icon}</span>}
        {label}
      </dt>
      <dd className="mt-1 truncate text-xs text-foreground" title={value}>
        {value}
      </dd>
    </div>
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
        <div key={key} className="flex items-center gap-4 p-4">
          <div className="min-w-0 flex-1">
            <Skeleton className="h-4 w-36 max-w-full" />
            <Skeleton className="mt-2 h-3 w-28 max-w-full" />
          </div>
          <Skeleton className="hidden h-8 w-72 sm:block" />
          <Skeleton className="h-8 w-16" />
        </div>
      ))}
    </div>
  );
}
