import React from "react";
import type { CredentialInfo } from "../../../../src/evaluation/account";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "../Dialog";
import { Button } from "../ui";

export function DeleteCredentialDialog({
  credential,
  onDelete,
  onClose,
}: {
  credential: CredentialInfo;
  onDelete(): Promise<void>;
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
      aria-labelledby="delete-credential-title"
      aria-describedby="delete-credential-description"
    >
      <DialogHeader
        title="Delete Credential"
        titleId="delete-credential-title"
        onClose={onClose}
        busy={busy}
      />
      <DialogBody>
        <p id="delete-credential-description" className="text-sm leading-6 text-muted-foreground">
          Delete <strong className="break-all text-foreground">{credential.name}</strong>? New runs
          won’t be able to use it.
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
              await onDelete();
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "Could not delete credential");
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Deleting…" : "Delete"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
