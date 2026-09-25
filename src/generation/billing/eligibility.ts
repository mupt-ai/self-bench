const BILLING_ELIGIBLE_STATUSES = new Set(["active", "trialing"]);

const BILLING_REQUIRED_CODE = "billing_required";
const BILLING_REQUIRED_ERROR = "Set up billing to use managed models or sandboxes.";

export interface BillingEligibility {
  readonly configured: boolean;
  readonly eligible: boolean;
  readonly status: string;
  readonly customerId?: string;
  readonly subscriptionId?: string;
  readonly cancelAtPeriodEnd: boolean;
  readonly currentPeriodEnd?: string;
}

function usesManagedResources(settings: {
  readonly modelAccess: string;
  readonly sandbox: string;
}): boolean {
  return settings.modelAccess === "managed" || settings.sandbox === "managed";
}

export function eligibilityFrom(
  configured: boolean,
  billing?: {
    readonly status: string;
    readonly stripeCustomerId?: string | null;
    readonly stripeSubscriptionId?: string | null;
    readonly cancelAtPeriodEnd: boolean;
    readonly currentPeriodEnd?: Date | null;
  },
): BillingEligibility {
  if (!configured) {
    return { configured: false, eligible: true, status: "disabled", cancelAtPeriodEnd: false };
  }
  const status = billing?.status ?? "none";
  return {
    configured: true,
    eligible: BILLING_ELIGIBLE_STATUSES.has(status),
    status,
    cancelAtPeriodEnd: billing?.cancelAtPeriodEnd ?? false,
    ...(billing?.stripeCustomerId ? { customerId: billing.stripeCustomerId } : {}),
    ...(billing?.stripeSubscriptionId ? { subscriptionId: billing.stripeSubscriptionId } : {}),
    ...(billing?.currentPeriodEnd
      ? { currentPeriodEnd: billing.currentPeriodEnd.toISOString() }
      : {}),
  };
}

/** Undefined means the run may proceed; otherwise the JSON error body to send as 403. */
export function managedBillingRefusal(
  settings: { readonly modelAccess: string; readonly sandbox: string },
  eligibility: BillingEligibility | undefined,
): { error: string; code: string } | undefined {
  if (!usesManagedResources(settings) || !eligibility || eligibility.eligible) return undefined;
  return { error: BILLING_REQUIRED_ERROR, code: BILLING_REQUIRED_CODE };
}
