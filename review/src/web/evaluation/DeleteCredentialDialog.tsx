import React from "react";
import type { CredentialInfo } from "../../../../src/evaluation/account";
import { Button } from "../ui";
import { useModalDialog } from "../useModalDialog";

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
  const dialog = useModalDialog(cancel);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  return (
    <dialog
      ref={dialog}
      aria-labelledby="delete-credential-title"
      aria-describedby="delete-credential-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      className="fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-md border border-line-strong bg-surface p-6 text-ink shadow-2xl backdrop:bg-black/65"
    >
      <h2 id="delete-credential-title" className="text-lg font-semibold">
        Delete Credential
      </h2>
      <p id="delete-credential-description" className="mt-3 text-sm leading-6 text-muted">
        Delete <strong className="break-all text-ink">{credential.name}</strong>? You’ll need to add
        it again to use it in new runs. Credentials used by active comparisons cannot be deleted.
      </p>
      {error && (
        <p role="alert" className="mt-4 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="mt-6 flex justify-end gap-2">
        <Button ref={cancel} disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={busy}
          className="border-danger/50 text-danger hover:border-danger hover:text-danger"
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
          {busy ? "Deleting…" : "Delete Credential"}
        </Button>
      </div>
    </dialog>
  );
}
