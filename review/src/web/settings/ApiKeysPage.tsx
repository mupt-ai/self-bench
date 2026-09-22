import { Plus } from "lucide-react";
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
      <PageHeader
        title="API Keys"
        description="Create personal keys for scripts and CI. Each key can reach every organization you belong to."
      >
        <Button size="small" variant="primary" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          Create Key
        </Button>
      </PageHeader>
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
