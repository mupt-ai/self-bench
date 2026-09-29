import React from "react";
import { Button } from "../ui";
import { formatBillingDollars, grantBillingCredit } from "./billing";

export function CreditGrant({ org }: { org: string }) {
  const [targetOrg, setTargetOrg] = React.useState("");
  const [amount, setAmount] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const requestId = React.useRef<string | null>(null);
  const [message, setMessage] = React.useState("");
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const amountCents = Math.round(Number(amount) * 100);
    if (
      !Number.isFinite(amountCents) ||
      amountCents < 1 ||
      amountCents > 1_000_000 ||
      !/^\d+(?:\.\d{1,2})?$/.test(amount)
    ) {
      setMessage("Enter an amount between $0.01 and $10,000.00 with at most two decimal places.");
      return;
    }
    if (
      !window.confirm(
        `Grant ${formatBillingDollars(amountCents / 100)} in Stripe invoice credits to ${targetOrg}?`,
      )
    )
      return;
    setBusy(true);
    setMessage("");
    try {
      requestId.current ??= crypto.randomUUID();
      await grantBillingCredit(org, {
        targetOrg,
        amountCents,
        reason,
        requestId: requestId.current,
      });
      requestId.current = null;
      setMessage("Credit granted in Stripe. It will apply to future invoices, not recorded usage.");
      setAmount("");
      setReason("");
    } catch (cause) {
      setMessage(
        `Could not grant credit: ${cause instanceof Error ? cause.message : "unknown error"}`,
      );
    } finally {
      setBusy(false);
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
      <form onSubmit={(event) => void submit(event)} className="mt-4 grid gap-3 sm:grid-cols-3">
        <label className="text-xs">
          Target Organization
          <input
            className="mt-1 w-full border border-border bg-background p-2 text-sm"
            required
            value={targetOrg}
            onChange={(event) => {
              requestId.current = null;
              setTargetOrg(event.target.value);
            }}
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
            onChange={(event) => {
              requestId.current = null;
              setAmount(event.target.value);
            }}
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
            onChange={(event) => {
              requestId.current = null;
              setReason(event.target.value);
            }}
            placeholder="Credit reason"
          />
        </label>
        <div className="sm:col-span-3">
          <Button disabled={busy} type="submit">
            {busy ? "Granting…" : "Grant Credit"}
          </Button>
        </div>
      </form>
      {message && (
        <p role="status" className="mt-3 text-sm">
          {message}
        </p>
      )}
    </section>
  );
}
