import React from "react";
import { Button } from "../ui";
import { formatBillingDollars, refundBillingUsage } from "./billing";

export function UsageRefund({ org, onRefunded }: { org: string; onRefunded: () => void }) {
  const [targetOrg, setTargetOrg] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (
      !window.confirm(`Refund all of ${targetOrg}'s managed usage in its current billing period?`)
    )
      return;
    setBusy(true);
    setMessage("");
    try {
      // The server refunds only usage no earlier refund covered, so a retry cannot double it.
      const { refundedUsd } = await refundBillingUsage(org, { targetOrg, reason });
      setMessage(
        refundedUsd > 0
          ? `Refunded ${formatBillingDollars(refundedUsd)}. Stripe removes it from the next invoice.`
          : "Nothing to refund in the current billing period.",
      );
      setTargetOrg("");
      setReason("");
      onRefunded();
    } catch (cause) {
      setMessage(`Refund failed: ${cause instanceof Error ? cause.message : "unknown error"}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="border border-border bg-card p-5" aria-labelledby="usage-refund-title">
      <h2 id="usage-refund-title" className="text-sm font-medium">
        Refund Usage
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Removes an organization's managed usage in its current billing period from the next Stripe
        invoice. Invoices already paid are refunded in Stripe.
      </p>
      <form onSubmit={(event) => void submit(event)} className="mt-4 grid gap-3 sm:grid-cols-2">
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
          Reason
          <input
            className="mt-1 w-full border border-border bg-background p-2 text-sm"
            required
            maxLength={200}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Refund reason"
          />
        </label>
        <div className="sm:col-span-2">
          <Button disabled={busy} type="submit">
            {busy ? "Refunding…" : "Refund Current Period"}
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
