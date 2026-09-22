import { CreditCard, RefreshCw } from "lucide-react";
import React from "react";
import { Skeleton } from "../LoadingSkeleton";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { Button, Notice, PageFrame, PageHeader } from "../ui";
import { BillingUsage } from "./BillingUsage";
import {
  type BillingStatus,
  fetchBilling,
  formatBillingDollars,
  startBillingSession,
} from "./billing";

const statusLabels: Record<string, string> = {
  disabled: "Not Configured",
  none: "Not Set Up",
  incomplete: "Incomplete",
  trialing: "Trialing",
  active: "Active",
  past_due: "Past Due",
  canceled: "Canceled",
  unpaid: "Unpaid",
  paused: "Paused",
};

export function BillingPage() {
  const { org } = useOrg();
  return <BillingContent key={org.login} org={org.login} />;
}

function BillingContent({ org }: { org: string }) {
  useDocumentTitle(`Billing · ${org}`);
  const [data, setData] = React.useState<BillingStatus>();
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const checkout = new URLSearchParams(window.location.search).get("checkout");
  const load = React.useCallback(async () => {
    setError("");
    try {
      setData(await fetchBilling(org));
    } catch (cause) {
      setError(
        `Could not load billing: ${cause instanceof Error ? cause.message : "unknown error"}`,
      );
    }
  }, [org]);
  React.useEffect(() => {
    let disposed = false;
    fetchBilling(org).then(
      (result) => {
        if (!disposed) setData(result);
      },
      (cause) => {
        if (!disposed) setError(`Could not load billing: ${cause.message}`);
      },
    );
    return () => {
      disposed = true;
    };
  }, [org]);
  const open = async (kind: "checkout" | "portal") => {
    setBusy(true);
    setError("");
    try {
      window.location.assign(await startBillingSession(org, kind));
    } catch (cause) {
      setBusy(false);
      setError(
        `Could not open Stripe: ${cause instanceof Error ? cause.message : "unknown error"}`,
      );
    }
  };
  const action =
    data?.canManage && data.configured && data.status === "none" ? "checkout" : "portal";
  const canOpenBilling = data?.canManage && (action === "checkout" || !!data?.customerId);
  return (
    <PageFrame>
      <PageHeader
        title="Billing"
        description="Understand managed model and sandbox costs, subscription access, and Stripe billing state."
      >
        {canOpenBilling && (
          <Button
            size="small"
            variant={action === "checkout" ? "primary" : "secondary"}
            disabled={busy}
            onClick={() => void open(action)}
          >
            <CreditCard className="h-4 w-4" aria-hidden="true" />
            {busy ? "Opening Stripe…" : action === "checkout" ? "Set Up Billing" : "Manage Billing"}
          </Button>
        )}
      </PageHeader>
      {checkout === "success" && (
        <Notice tone="success" className="mb-6">
          Checkout finished. Subscription status updates after Stripe confirms the webhook.
        </Notice>
      )}
      {error && (
        <Notice className="mb-6">
          <p>{error}</p>
          <Button size="small" onClick={() => void load()}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Reload Billing
          </Button>
        </Notice>
      )}
      {!data && !error && <BillingSkeleton />}
      {data && (
        <div className="grid gap-8">
          <BillingSummary data={data} />
          <BillingStatusCard data={data} />
          <BillingUsage usage={data.usage} />
        </div>
      )}
    </PageFrame>
  );
}

export function BillingSummary({ data }: { data: BillingStatus }) {
  const modelCost = data.usage.modelBillableUsd;
  const sandboxCost = data.usage.sandboxBillableUsd;
  const totalCost = modelCost + sandboxCost;
  return (
    <section aria-labelledby="billing-summary-title" className="border border-border bg-card">
      <div className="grid lg:grid-cols-[1.2fr_1fr]">
        <div className="border-b border-border p-5 lg:border-r lg:border-b-0">
          <p
            id="billing-summary-title"
            className="text-xs tracking-wider text-muted-foreground uppercase"
          >
            Total Recorded Cost
          </p>
          <p className="mt-2 text-3xl font-medium tracking-tight tabular-nums">
            {formatBillingDollars(totalCost)}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            All-time billable managed usage. Final invoices and payments are managed in Stripe.
          </p>
        </div>
        <div className="p-5">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="text-muted-foreground">Cost Breakdown</span>
            <span className="tabular-nums text-foreground">{formatBillingDollars(totalCost)}</span>
          </div>
          <div
            className="mt-3 flex h-2 overflow-hidden bg-muted"
            role="img"
            aria-label={`Model cost: ${formatBillingDollars(modelCost)}; sandbox cost: ${formatBillingDollars(sandboxCost)}`}
          >
            {modelCost > 0 && <span className="bg-brand" style={{ flexGrow: modelCost }} />}
            {sandboxCost > 0 && (
              <span className="bg-foreground/50" style={{ flexGrow: sandboxCost }} />
            )}
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-4">
            <CostLegend label="Models" value={modelCost} className="bg-brand" />
            <CostLegend label="Sandboxes" value={sandboxCost} className="bg-foreground/50" />
          </dl>
        </div>
      </div>
    </section>
  );
}

export function BillingStatusCard({ data }: { data: BillingStatus }) {
  const periodEnd = data.currentPeriodEnd
    ? new Date(data.currentPeriodEnd).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      })
    : "Not Available";
  const status = statusLabels[data.status] ?? data.status.replaceAll("_", " ");
  return (
    <section aria-labelledby="subscription-title">
      <div className="mb-3">
        <h2 id="subscription-title" className="text-sm font-medium">
          Subscription and Limits
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Current Stripe state and access to managed resources.
        </p>
      </div>
      <dl className="grid border border-border bg-card sm:grid-cols-2 lg:grid-cols-4 lg:divide-x lg:divide-border">
        <StatusMetric label="Subscription Status" value={status} active={data.eligible} />
        <StatusMetric
          label="Managed Access"
          value={data.eligible ? "Available" : data.configured ? "Blocked" : "Not Enforced"}
        />
        <StatusMetric label="Current Period Ends" value={periodEnd} />
        <StatusMetric label="Usage Limits" value="Not Available in SelfBench" />
      </dl>
      <div className="border-x border-b border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
        {data.cancelAtPeriodEnd ? (
          <p>
            This subscription is scheduled to cancel at the end of the current period on {periodEnd}
            .
          </p>
        ) : !data.configured ? (
          <p>Stripe is not configured. Managed usage is recorded but not invoiced.</p>
        ) : !data.canManage ? (
          <p>Only organization admins can manage the subscription and payment details.</p>
        ) : (
          <p>Manage payment details, invoices, and any account-level controls in Stripe.</p>
        )}
      </div>
    </section>
  );
}

function StatusMetric({
  label,
  value,
  active = false,
}: {
  label: string;
  value: string;
  active?: boolean;
}) {
  return (
    <div className="border-b border-border p-4 sm:[&:nth-child(odd)]:border-r lg:border-b-0 lg:[&:nth-child(odd)]:border-r-0">
      <dt className="text-[10px] tracking-wider text-muted-foreground uppercase">{label}</dt>
      <dd className="mt-2 flex items-center gap-2 text-sm text-foreground">
        {active && <span className="size-1.5 bg-success" aria-hidden="true" />}
        {value}
      </dd>
    </div>
  );
}

function CostLegend({
  label,
  value,
  className,
}: {
  label: string;
  value: number;
  className: string;
}) {
  return (
    <div>
      <dt className="flex items-center gap-2 text-[10px] tracking-wider text-muted-foreground uppercase">
        <span className={`size-1.5 ${className}`} aria-hidden="true" />
        {label}
      </dt>
      <dd className="mt-1 text-sm tabular-nums text-foreground">{formatBillingDollars(value)}</dd>
    </div>
  );
}

function BillingSkeleton() {
  return (
    <div role="status" aria-label="Loading Billing" className="grid gap-8">
      <span className="sr-only">Loading billing…</span>
      <div className="grid border border-border bg-card lg:grid-cols-2">
        <div className="border-b border-border p-5 lg:border-r lg:border-b-0">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="mt-3 h-9 w-40" />
          <Skeleton className="mt-3 h-3 w-72 max-w-full" />
        </div>
        <div className="p-5">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="mt-4 h-2 w-full" />
          <Skeleton className="mt-4 h-8 w-48 max-w-full" />
        </div>
      </div>
      <div>
        <Skeleton className="mb-3 h-4 w-44" />
        <div className="grid border border-border bg-card sm:grid-cols-2 lg:grid-cols-4">
          {["status", "access", "period", "limits"].map((key) => (
            <div key={key} className="border-b border-border p-4">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="mt-3 h-4 w-32 max-w-full" />
            </div>
          ))}
        </div>
      </div>
      <div>
        <Skeleton className="mb-3 h-4 w-32" />
        <div className="grid gap-3 lg:grid-cols-2">
          <Skeleton className="h-44 w-full border border-border" />
          <Skeleton className="h-44 w-full border border-border" />
        </div>
      </div>
    </div>
  );
}
