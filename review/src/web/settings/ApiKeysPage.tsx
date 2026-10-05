import { KeyRound, Plus, ShieldCheck } from "lucide-react";
import React from "react";
import { useDocumentTitle } from "../session";
import { Button, Notice, PageFrame, PageHeader } from "../ui";
import { ApiKeyList } from "./ApiKeyList";
import { type ApiKey, type CreatedApiKey, fetchApiKeys, revokeApiKey } from "./api-keys";
import { CreateApiKeyDialog } from "./CreateApiKeyDialog";
import { NewApiKeySecret } from "./NewApiKeySecret";
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
      <PageHeader title="API Keys" description="Manage keys for scripts and CI.">
        <Button size="small" variant="primary" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          Create Key
        </Button>
      </PageHeader>
      <section className="mb-8 grid border border-border bg-card sm:grid-cols-2">
        <div className="border-b border-border p-4 sm:border-r sm:border-b-0">
          <div className="flex items-start gap-3">
            <KeyRound className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden="true" />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">Use a Key</h2>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Send it as a bearer token or with the X-API-Key header.
              </p>
              <code className="mt-3 block overflow-x-auto border border-border bg-background px-3 py-2 font-mono text-xs text-foreground">
                Authorization: Bearer sbk_…
              </code>
            </div>
          </div>
        </div>
        <div className="p-4">
          <div className="flex items-start gap-3">
            <ShieldCheck
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <div>
              <h2 className="text-sm font-semibold">Choose a Scope</h2>
              <div className="mt-2 grid gap-1.5 text-xs">
                <p>
                  <span className="font-medium text-foreground">Read Only</span>
                  <span className="text-muted-foreground"> — list and download</span>
                </p>
                <p>
                  <span className="font-medium text-foreground">Read &amp; Write</span>
                  <span className="text-muted-foreground"> — manage resources as you</span>
                </p>
              </div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                Keys inherit your workspace access. The full secret appears only once.
              </p>
            </div>
          </div>
        </div>
      </section>
      {error && (
        <Notice className="mb-6">
          <p>{error}</p>
          <Button size="small" onClick={() => void refresh()}>
            Reload List
          </Button>
        </Notice>
      )}
      {notice && (
        <Notice tone="success" className="mb-6">
          {notice}
        </Notice>
      )}
      {created && <NewApiKeySecret created={created} onDismiss={() => setCreated(undefined)} />}
      {(!error || keys) && (
        <ApiKeyList keys={keys} loading={!keys && !error} onRevoke={setRevoking} />
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
