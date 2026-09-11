import React from "react";
import { type BatchRepoId, cancelBatch } from "../batch-api";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "../Dialog";
import { Button, Notice } from "../ui";

export function CancelBatch({
  repoId,
  runId,
  onCancelled,
}: {
  repoId: BatchRepoId;
  runId: string;
  onCancelled(): void;
}) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [requested, setRequested] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const submitting = React.useRef(false);
  const keep = React.useRef<HTMLButtonElement>(null);
  const titleId = React.useId();
  return (
    <>
      <Button disabled={requested} onClick={() => setOpen(true)}>
        {requested ? "Cancellation Requested…" : "Cancel Batch"}
      </Button>
      {open && (
        <Dialog
          initialFocus={keep}
          onDismiss={() => setOpen(false)}
          busy={busy}
          size="small"
          aria-labelledby={titleId}
        >
          <DialogHeader
            title="Cancel Batch?"
            titleId={titleId}
            onClose={() => setOpen(false)}
            busy={busy}
          />
          <DialogBody>
            <p className="text-sm text-muted-foreground">
              Stop generation for this batch? Tasks already generated will remain in the dataset.
            </p>
            {error && <Notice>{error}</Notice>}
          </DialogBody>
          <DialogFooter>
            <Button ref={keep} disabled={busy} onClick={() => setOpen(false)}>
              Keep Running
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                if (submitting.current) return;
                submitting.current = true;
                setBusy(true);
                setError(undefined);
                try {
                  await cancelBatch(repoId, runId);
                  setRequested(true);
                  setOpen(false);
                  onCancelled();
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : "Could not cancel batch.");
                } finally {
                  submitting.current = false;
                  setBusy(false);
                }
              }}
            >
              {busy ? "Cancelling…" : "Cancel Batch"}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </>
  );
}
