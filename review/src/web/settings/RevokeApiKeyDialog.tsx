import React from "react";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "../Dialog";
import { Button } from "../ui";
import type { ApiKey } from "./api-keys";

export function RevokeApiKeyDialog({
  apiKey,
  onRevoke,
  onClose,
}: {
  apiKey: ApiKey;
  onRevoke(): Promise<void>;
  onClose(): void;
}) {
  const cancel = React.useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  return (
    <Dialog
      initialFocus={cancel}
      onDismiss={onClose}
      busy={busy}
      size="small"
      aria-labelledby="revoke-api-key-title"
      aria-describedby="revoke-api-key-description"
    >
      <DialogHeader
        title="Revoke API Key"
        titleId="revoke-api-key-title"
        onClose={onClose}
        busy={busy}
      />
      <DialogBody>
        <p id="revoke-api-key-description" className="text-sm leading-6 text-muted-foreground">
          Revoke <strong className="break-all text-foreground">{apiKey.name}</strong> (
          <code className="font-mono">{apiKey.prefix}…</code>)? Requests using it will stop working
          immediately.
        </p>
        {error && (
          <p role="alert" className="mt-4 text-sm text-destructive">
            {error}
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button ref={cancel} disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={busy}
          variant="destructive"
          onClick={async () => {
            setBusy(true);
            try {
              await onRevoke();
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "Could not revoke the key");
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Revoking…" : "Revoke"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
