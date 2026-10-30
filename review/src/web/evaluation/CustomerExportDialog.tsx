import React from "react";
import type { CustomerExport } from "../../../../src/customer-exports/types";
import { Dialog, DialogBody } from "../Dialog";
import { Button, fieldStyles, Input, Notice } from "../ui";
import type { EvaluationRun } from "./api";
import { evaluationRequest, evaluationRequestId } from "./api";

export function CustomerExportButton({ url, runs }: { url: string; runs: EvaluationRun[] }) {
  const [open, setOpen] = React.useState(false);
  const finished = runs.filter((run) => run.status === "completed");
  return (
    <>
      <Button disabled={!finished.length} onClick={() => setOpen(true)}>
        Export for Customer
      </Button>
      {open && <CustomerExportDialog url={url} runs={finished} onClose={() => setOpen(false)} />}
    </>
  );
}
function CustomerExportDialog({
  url,
  runs,
  onClose,
}: {
  url: string;
  runs: EvaluationRun[];
  onClose(): void;
}) {
  const cancel = React.useRef<HTMLButtonElement>(null);
  const customerId = React.useId();
  const emailId = React.useId();
  const [customer, setCustomer] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [evaluationId, setEvaluationId] = React.useState(runs[0]?.id ?? "");
  const [exports, setExports] = React.useState<CustomerExport[]>([]);
  const [enabled, setEnabled] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [id, setId] = React.useState(evaluationRequestId);
  const refresh = React.useCallback(async () => {
    const found = await evaluationRequest<{ enabled: boolean; exports: CustomerExport[] }>(
      `${url}/exports`,
    );
    setExports(found.exports);
    setEnabled(found.enabled);
  }, [url]);
  React.useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (!disposed) await refresh();
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : "Could not load exports");
      }
      if (!disposed) timer = setTimeout(() => void poll(), 5000);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [refresh]);
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await evaluationRequest(`${url}/exports`, { id, customer, email, evaluationId });
      setId(evaluationRequestId());
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create export");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      aria-label="Export for Customer"
      onDismiss={onClose}
      initialFocus={cancel}
      size="medium"
    >
      <DialogBody>
        <h2 className="mb-3 text-lg font-semibold">Export for Customer</h2>
        <p className="text-sm text-muted-foreground">
          Copy this evaluation’s verified images into a dedicated private Google registry. The
          customer runs Harbor on their own machine, with direct Google access—not through
          SelfBench.
        </p>
        {error && <Notice className="mt-4">{error}</Notice>}
        {!enabled && (
          <Notice className="mt-4">
            Customer exports require the deployment’s Cloud Build image builder.
          </Notice>
        )}
        <form className="mt-5 grid gap-4" onSubmit={(event) => void create(event)}>
          <label className={fieldStyles}>
            Evaluation
            <select
              className="rounded border border-border bg-background p-2"
              value={evaluationId}
              onChange={(event) => {
                setEvaluationId(event.target.value);
                setId(evaluationRequestId());
              }}
              disabled={busy}
            >
              {runs.map((run) => (
                <option key={run.id} value={run.id}>
                  {run.modelLabel} · {new Date(run.createdAt).toLocaleString()} ·{" "}
                  {run.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          <label className={fieldStyles} htmlFor={customerId}>
            Customer Name
            <Input
              id={customerId}
              required
              maxLength={100}
              value={customer}
              disabled={busy}
              onChange={(event) => {
                setCustomer(event.target.value);
                setId(evaluationRequestId());
              }}
            />
          </label>
          <label className={fieldStyles} htmlFor={emailId}>
            Google Account Email
            <Input
              id={emailId}
              required
              type="email"
              value={email}
              disabled={busy}
              onChange={(event) => {
                setEmail(event.target.value);
                setId(evaluationRequestId());
              }}
            />
          </label>
          <p className="text-sm text-muted-foreground">
            The ZIP and verifier images include hidden tests and reference solutions. Keep them
            private. Google access has no automatic expiry; manage access and retention in the
            dedicated repository.
          </p>
          <div className="flex justify-end gap-2">
            <Button ref={cancel} type="button" onClick={onClose}>
              Close
            </Button>
            <Button variant="primary" type="submit" disabled={busy || !enabled}>
              {busy ? "Creating…" : "Create Export"}
            </Button>
          </div>
        </form>
        {exports.length > 0 && (
          <section className="mt-6 border-t border-border pt-4">
            <h3 className="font-semibold">Customer Exports</h3>
            <ul className="mt-3 grid gap-4">
              {exports.map((entry) => (
                <li key={entry.id} className="grid gap-1 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <strong>{entry.customer}</strong>
                    {entry.status === "ready" ? (
                      <a
                        className="underline underline-offset-4"
                        href={`${url}/exports/${entry.id}/download`}
                      >
                        Download Harbor ZIP
                      </a>
                    ) : (
                      <span>
                        {entry.status === "preparing" ? "Preparing Images…" : "Export Failed"}
                      </span>
                    )}
                  </div>
                  <span className="text-muted-foreground">
                    {entry.email} · {new Date(entry.createdAt).toLocaleString()}
                  </span>
                  {entry.repository && (
                    <code className="break-all text-xs">{entry.repository}</code>
                  )}
                  {entry.error && <Notice>{entry.error}</Notice>}
                </li>
              ))}
            </ul>
          </section>
        )}
      </DialogBody>
    </Dialog>
  );
}
