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
      {open && <CustomerExportDialog url={url} onClose={() => setOpen(false)} />}
    </>
  );
}
function CustomerExportDialog({ url, onClose }: { url: string; onClose(): void }) {
  const cancel = React.useRef<HTMLButtonElement>(null);
  const customerId = React.useId();
  const [customer, setCustomer] = React.useState("");
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
    refresh().catch((cause) =>
      setError(cause instanceof Error ? cause.message : "Could not load exports"),
    );
  }, [refresh]);
  const act = async (work: () => Promise<unknown>, failure: string) => {
    setBusy(true);
    setError("");
    try {
      await work();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : failure);
    } finally {
      setBusy(false);
    }
  };
  const create = (event: React.FormEvent) => {
    event.preventDefault();
    void act(async () => {
      await evaluationRequest(`${url}/exports`, { id, customer });
      setId(evaluationRequestId());
      setCustomer("");
    }, "Could not create export");
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
          Shares the newest evaluation’s tasks as a Harbor ZIP.
        </p>
        {error && <Notice className="mt-4">{error}</Notice>}
        {!enabled && (
          <Notice className="mt-4">
            Customer exports need an Artifact Registry task repository.
          </Notice>
        )}
        <form className="mt-5 grid gap-4" onSubmit={create}>
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
          <p className="text-sm text-muted-foreground">
            Includes hidden tests, solutions, and a pull key that works for 30 days.
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
                      <span className="flex gap-3">
                        <a
                          className="underline underline-offset-4"
                          href={`${url}/exports/${entry.id}/download`}
                        >
                          Download Harbor ZIP
                        </a>
                        <button
                          type="button"
                          className="underline underline-offset-4"
                          disabled={busy}
                          onClick={() =>
                            void act(
                              () => evaluationRequest(`${url}/exports/${entry.id}/revoke`, {}),
                              "Could not revoke export",
                            )
                          }
                        >
                          Revoke
                        </button>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">
                        {entry.status === "revoked" ? "Revoked" : "Expired"}
                      </span>
                    )}
                  </div>
                  <span className="text-muted-foreground">
                    Tasks from the evaluation of{" "}
                    {new Date(entry.evaluationCreatedAt).toLocaleString()}
                    {entry.status === "ready" &&
                      ` · Key works until ${new Date(entry.expiresAt).toLocaleDateString()}`}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </DialogBody>
    </Dialog>
  );
}
