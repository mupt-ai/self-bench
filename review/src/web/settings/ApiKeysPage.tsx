import { Check, Copy, Plus } from "lucide-react";
import React from "react";
import { formatAgo } from "../api";
import { Skeleton } from "../LoadingSkeleton";
import { useDocumentTitle } from "../session";
import { Button, DataTable, EmptyState, Notice, PageFrame, PageHeader } from "../ui";
import {
  type ApiKey,
  type CreatedApiKey,
  fetchApiKeys,
  revokeApiKey,
  scopeLabels,
} from "./api-keys";
import { CreateApiKeyDialog } from "./CreateApiKeyDialog";
import { RevokeApiKeyDialog } from "./RevokeApiKeyDialog";

export function ApiKeysPage() {
  useDocumentTitle("API Keys");
  const [keys, setKeys] = React.useState<ApiKey[]>();
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [created, setCreated] = React.useState<CreatedApiKey>();
  const [creating, setCreating] = React.useState(false);
  const [revoking, setRevoking] = React.useState<ApiKey>();
  React.useEffect(() => {
    let disposed = false;
    fetchApiKeys().then(
      (result) => {
        if (!disposed) setKeys(result);
      },
      (cause) => {
        if (!disposed) setError(`Could not load API keys: ${cause.message}`);
      },
    );
    return () => {
      disposed = true;
    };
  }, []);
  const refresh = async () => {
    try {
      setKeys(await fetchApiKeys());
      setError("");
    } catch {
      setError("Could not refresh API keys. Reload the list to try again.");
    }
  };
  return (
    <PageFrame>
      <PageHeader
        title="API Keys"
        description="Use the API as yourself from scripts and CI. Keys reach every organization you belong to."
      >
        <Button size="small" onClick={() => setCreating(true)}>
          <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
          Create Key
        </Button>
      </PageHeader>
      {error && (
        <Notice className="mb-6">
          <p>{error}</p>
          <Button onClick={() => void refresh()}>Reload List</Button>
        </Notice>
      )}
      {notice && (
        <Notice tone="success" className="mb-6">
          {notice}
        </Notice>
      )}
      {created && <NewSecret created={created} onDismiss={() => setCreated(undefined)} />}
      {(!error || keys) && (
        <KeyTable keys={keys} loading={!keys && !error} onRevoke={setRevoking} />
      )}
      {creating && (
        <CreateApiKeyDialog
          onCancel={() => setCreating(false)}
          onCreated={async (result) => {
            setCreating(false);
            setNotice("");
            setCreated(result);
            await refresh();
          }}
        />
      )}
      {revoking && (
        <RevokeApiKeyDialog
          apiKey={revoking}
          onClose={() => setRevoking(undefined)}
          onRevoke={async () => {
            await revokeApiKey(revoking.id);
            setRevoking(undefined);
            if (created?.key.id === revoking.id) setCreated(undefined);
            setNotice("API key revoked.");
            await refresh();
          }}
        />
      )}
    </PageFrame>
  );
}

/** The one and only time the secret is visible; it is never sent by the server again. */
function NewSecret({ created, onDismiss }: { created: CreatedApiKey; onDismiss(): void }) {
  const [copied, setCopied] = React.useState<"idle" | "copied" | "failed">("idle");
  const secret = React.useRef<HTMLElement>(null);
  React.useEffect(() => {
    if (copied !== "copied") return;
    const timer = window.setTimeout(() => setCopied("idle"), 2_500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    const ok = await copyText(created.secret, secret.current);
    setCopied(ok ? "copied" : "failed");
    if (!ok) selectContents(secret.current);
  };
  return (
    <section
      aria-labelledby="new-api-key-title"
      className="mb-6 space-y-3 border border-success/30 bg-success/[0.06] p-4"
    >
      <h2 id="new-api-key-title" className="text-sm font-semibold text-foreground">
        {created.key.name} created
      </h2>
      <p className="text-sm text-muted-foreground">Copy the key now. It will not be shown again.</p>
      <div className="flex flex-wrap items-center gap-2">
        <code
          ref={secret}
          data-testid="api-key-secret"
          className="min-w-0 max-w-full break-all border border-border bg-background px-3 py-2 font-mono text-xs select-all"
        >
          {created.secret}
        </code>
        <Button
          size="small"
          variant={copied === "copied" ? "primary" : "secondary"}
          onClick={() => void copy()}
          aria-label="Copy API Key"
        >
          {copied === "copied" ? (
            <Check className="mr-1 h-4 w-4" aria-hidden="true" />
          ) : (
            <Copy className="mr-1 h-4 w-4" aria-hidden="true" />
          )}
          {copied === "copied" ? "Copied" : "Copy"}
        </Button>
        <Button size="small" variant="ghost" onClick={onDismiss}>
          Done
        </Button>
      </div>
      <p
        role="status"
        className={copied === "failed" ? "text-sm text-destructive" : "text-sm text-success"}
      >
        {copied === "copied" && "Copied to clipboard."}
        {copied === "failed" &&
          "Copying is not available here. The key is selected; press ⌘C or Ctrl+C to copy it."}
      </p>
    </section>
  );
}

/** Clipboard API first (secure contexts only), then the selection-based command older pages use. */
async function copyText(text: string, node: HTMLElement | null): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the selection-based copy
  }
  try {
    if (!selectContents(node)) return false;
    return document.execCommand("copy");
  } catch {
    return false;
  }
}

function selectContents(node: HTMLElement | null): boolean {
  const selection = window.getSelection();
  if (!node || !selection) return false;
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

function KeyTable({
  keys,
  loading,
  onRevoke,
}: {
  keys: ApiKey[] | undefined;
  loading: boolean;
  onRevoke(key: ApiKey): void;
}) {
  if (loading) {
    return (
      <div role="status" aria-label="Loading API Keys" className="panel divide-y divide-border">
        {Array.from({ length: 2 }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed, stateless loading placeholders.
          <div key={index} className="px-4 py-3.5">
            <Skeleton className="h-5 w-36 max-w-full" />
            <Skeleton className="mt-1 h-4 w-48 max-w-full" />
          </div>
        ))}
      </div>
    );
  }
  if (!keys?.length) {
    return (
      <EmptyState title="No API Keys Yet">
        Create a key, then send it as <code className="font-mono">Authorization: Bearer</code> or{" "}
        <code className="font-mono">X-API-Key</code> on any request the site makes.
      </EmptyState>
    );
  }
  return (
    <DataTable>
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Key</th>
          <th scope="col">Scope</th>
          <th scope="col">Created</th>
          <th scope="col">Last Used</th>
          <th scope="col">
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {keys.map((key) => (
          <tr key={key.id}>
            <td className="font-semibold">{key.name}</td>
            <td className="font-mono text-xs">{key.prefix}…</td>
            <td>{scopeLabels[key.scope]}</td>
            <td className="whitespace-nowrap text-muted-foreground">
              {key.createdAt.slice(0, 10)}
            </td>
            <td className="whitespace-nowrap text-muted-foreground">
              {key.lastUsedAt ? formatAgo(key.lastUsedAt) : "Never"}
            </td>
            <td className="text-right">
              <Button size="small" onClick={() => onRevoke(key)} aria-label={`Revoke ${key.name}`}>
                Revoke
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}
