import React from "react";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { Button, Notice, PageFrame, PageHeader } from "../ui";
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
      {data && <BillingStatusCard data={data} />}
    </PageFrame>
  );
}

function BillingStatusCard({ data }: { data: BillingStatus }) {
  return (
    <section className="grid gap-2 border border-border bg-card p-4">
      <h2 className="text-sm font-medium text-foreground">Subscription</h2>
      <p className="text-sm text-muted-foreground">
        Status: {statusLabels[data.status] ?? data.status}
        {data.eligible
          ? " · managed runs are allowed"
          : data.configured
            ? " · managed runs are blocked"
            : ""}
        {data.currentPeriodEnd
          ? ` · current period ends ${new Date(data.currentPeriodEnd).toLocaleDateString()}`
          : ""}
        {data.cancelAtPeriodEnd ? " · cancels at period end" : ""}
      </p>
      {!data.configured && (
        <p className="text-sm text-muted-foreground">
          Stripe is not configured on this deployment, so managed usage is recorded but not
          invoiced.
        </p>
      )}
    </section>
  );
}
