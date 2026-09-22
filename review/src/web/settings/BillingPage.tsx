import React from "react";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { Button, Notice, PageFrame, PageHeader } from "../ui";
import { BillingUsage } from "./BillingUsage";
import { type BillingStatus, fetchBilling, startBillingSession } from "./billing";

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
  return (
    <PageFrame>
      <PageHeader
        title="Billing"
        description="Managed model and sandbox usage is invoiced through Stripe. Credentials you store are billed by their providers."
      >
        {data?.canManage && data.configured && data.status === "none" && (
          <Button size="small" disabled={busy} onClick={() => void open("checkout")}>
            Set Up Billing
          </Button>
        )}
        {data?.canManage && data.customerId && (
          <Button size="small" disabled={busy} onClick={() => void open("portal")}>
            Manage Billing
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
        </Notice>
      )}
      {data && (
        <div className="grid gap-8">
          <BillingStatusCard data={data} />
          <BillingUsage usage={data.usage} />
        </div>
      )}
    </PageFrame>
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
  return (
    <section aria-label="Subscription">
      <div className="mb-3">
        <h2 className="text-sm font-semibold">Subscription</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Stripe status and access to managed resources.
        </p>
      </div>
      <dl className="panel grid md:grid-cols-3 md:divide-x md:divide-border [&>div]:border-b [&>div]:border-border [&>div]:p-4 md:[&>div]:border-b-0">
        <StatusMetric
          label="Status"
          value={statusLabels[data.status] ?? data.status}
          active={data.eligible}
        />
        <StatusMetric
          label="Managed Usage"
          value={data.eligible ? "Allowed" : data.configured ? "Blocked" : "Not Enforced"}
        />
        <StatusMetric label="Current Period Ends" value={periodEnd} />
      </dl>
      {data.cancelAtPeriodEnd && (
        <p className="border-x-[1.5px] border-b-[1.5px] border-foreground/15 bg-muted px-4 py-2 text-xs text-muted-foreground">
          This subscription cancels at the end of the current period.
        </p>
      )}
      {!data.configured && (
        <p className="mt-3 text-xs text-muted-foreground">
          Stripe is not configured. Managed usage is recorded but not invoiced.
        </p>
      )}
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
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1.5 flex items-center gap-2 text-sm font-semibold text-foreground">
        {active && <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />}
        {value}
      </dd>
    </div>
  );
}
