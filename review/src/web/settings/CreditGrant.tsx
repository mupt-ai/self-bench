import React from "react";
import { Button } from "../ui";
import { type CreditGrantRequest, formatBillingDollars, grantBillingCredit } from "./billing";

const storageKey = (org: string) => `selfbench.billing.pending-credit.${org}`;

function restorePending(org: string): CreditGrantRequest | null {
  const raw = window.sessionStorage.getItem(storageKey(org));
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      value &&
      typeof value === "object" &&
      "requestId" in value &&
      typeof value.requestId === "string" &&
      "targetOrg" in value &&
      typeof value.targetOrg === "string" &&
      "amountCents" in value &&
      typeof value.amountCents === "number" &&
      "reason" in value &&
      typeof value.reason === "string"
    )
      return value as CreditGrantRequest;
  } catch {
    // Keep malformed pending data rather than silently allowing a new grant.
  }
  throw new Error(
    "A pending credit request could not be restored. Reconcile it before granting again.",
  );
}

export function CreditGrant({ org }: { org: string }) {
  const [targetOrg, setTargetOrg] = React.useState("");
  const [amount, setAmount] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [pending, setPending] = React.useState<CreditGrantRequest | null>(() =>
    restorePending(org),
  );
  const [message, setMessage] = React.useState("");

  const send = async (input: CreditGrantRequest) => {
    setBusy(true);
    setMessage("");
    try {
      const result = await grantBillingCredit(org, input);
      if (result.pending) {
        setMessage(
          `Credit status is unresolved (request ${input.requestId}). Reconcile in Stripe before granting another credit.`,
        );
        return;
      }
      window.sessionStorage.removeItem(storageKey(org));
      setPending(null);
      setMessage("Credit granted in Stripe. It will apply to future invoices, not recorded usage.");
      setTargetOrg("");
      setAmount("");
      setReason("");
    } catch (cause) {
      setMessage(
        `Credit status is uncertain. Retry this same request; do not grant another credit. ${cause instanceof Error ? cause.message : "Unknown error."}`,
      );
    } finally {
      setBusy(false);
    }
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (pending || busy) return;
    const amountCents = Math.round(Number(amount) * 100);
    if (
      !Number.isFinite(amountCents) ||
      amountCents < 1 ||
      amountCents > 10_000 ||
      !/^\d+(?:\.\d{1,2})?$/.test(amount)
    ) {
      setMessage("Enter an amount between $0.01 and $100.00 with at most two decimal places.");
      return;
    }
    if (
      !window.confirm(
        `Grant ${formatBillingDollars(amountCents / 100)} in Stripe invoice credits to ${targetOrg}?`,
      )
    )
      return;
    const input = { targetOrg, amountCents, reason, requestId: crypto.randomUUID() };
    try {
      // Reserve the exact request across reloads before any network call. Fail closed if storage is unavailable.
      window.sessionStorage.setItem(storageKey(org), JSON.stringify(input));
      setPending(input);
      void send(input);
    } catch {
      setMessage(
        "Cannot safely save this credit request. Enable session storage before granting credit.",
      );
    }
  };
  return (
    <section className="border border-border bg-card p-5" aria-labelledby="credit-grant-title">
      <h2 id="credit-grant-title" className="text-sm font-medium">
        Grant Invoice Credit
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Credits reduce future Stripe invoices; they do not change recorded usage.
      </p>
      {pending ? (
        <div className="mt-4 text-sm">
          <p>
            Unresolved credit for {pending.targetOrg}:{" "}
            {formatBillingDollars(pending.amountCents / 100)}. Do not create another grant until
            this request is resolved.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">Request ID: {pending.requestId}</p>
          <Button className="mt-3" disabled={busy} onClick={() => void send(pending)}>
            {busy ? "Checking…" : "Retry Same Request"}
          </Button>
        </div>
      ) : (
        <form onSubmit={submit} className="mt-4 grid gap-3 sm:grid-cols-3">
          <label className="text-xs">
            Target Organization
            <input
              className="mt-1 w-full border border-border bg-background p-2 text-sm"
              required
              value={targetOrg}
              onChange={(event) => setTargetOrg(event.target.value)}
              placeholder="GitHub org login"
            />
          </label>
          <label className="text-xs">
            Amount (USD)
            <input
              className="mt-1 w-full border border-border bg-background p-2 text-sm"
              required
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="10.00"
            />
          </label>
          <label className="text-xs">
            Reason
            <input
              className="mt-1 w-full border border-border bg-background p-2 text-sm"
              required
              maxLength={200}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Credit reason"
            />
          </label>
          <div className="sm:col-span-3">
            <Button disabled={busy} type="submit">
              {busy ? "Granting…" : "Grant Credit"}
            </Button>
          </div>
        </form>
      )}
      {message && (
        <p role="status" className="mt-3 text-sm">
          {message}
        </p>
      )}
    </section>
  );
}
