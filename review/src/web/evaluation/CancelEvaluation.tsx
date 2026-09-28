import React from "react";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "../Dialog";
import { Button, Notice } from "../ui";
import { evaluationRequest } from "./api";

/** Stops a live run or comparison after confirmation; finished trials keep their results. */
export function CancelEvaluation<Result>({
  endpoint,
  subject,
  onCancelled,
}: {
  endpoint: string;
  subject: "Run" | "Comparison";
  onCancelled(result: Result): void;
}) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const submitting = React.useRef(false);
  const keep = React.useRef<HTMLButtonElement>(null);
  const titleId = React.useId();
  const close = () => setOpen(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Cancel {subject}</Button>
      {open && (
        <Dialog
          initialFocus={keep}
          onDismiss={close}
          busy={busy}
          size="small"
          aria-labelledby={titleId}
        >
          <DialogHeader
            title={`Cancel ${subject}?`}
            titleId={titleId}
            onClose={close}
            busy={busy}
          />
          <DialogBody>
            <p className="text-sm text-muted-foreground">
              Running trials are stopped and queued trials never start. Finished trials keep their
              results. This cannot be resumed.
            </p>
            {error && <Notice>{error}</Notice>}
          </DialogBody>
          <DialogFooter>
            <Button ref={keep} disabled={busy} onClick={close}>
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
                  onCancelled(await evaluationRequest<Result>(endpoint, {}));
                  setOpen(false);
                } catch (cause) {
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : `Could not cancel the ${subject.toLowerCase()}.`,
                  );
                } finally {
                  submitting.current = false;
                  setBusy(false);
                }
              }}
            >
              {busy ? "Cancelling…" : `Cancel ${subject}`}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </>
  );
}
