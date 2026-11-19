import React from "react";
import type { DariLinkStatus } from "../../../../src/gateway/dari-link/connection";
import { Skeleton } from "../LoadingSkeleton";
import { cn } from "../primitives/cn";
import { evaluationRequest } from "./api";

// Each plan's row and usage limits as dari.dev's subscriptions list draws them
// (dari-mono dari-frontend/src/components/SubscriptionCredentials.tsx).

type Plan = Extract<DariLinkStatus, { plans: unknown }>["plans"][number];

/**
 * Each plan or key a Dari connection shares, as Dari reports it now: one row per plan with its
 * account, and a meter per usage limit with when it resets.
 */
export function DariPlans({ org, credentialId }: { org: string; credentialId: string }) {
  const [status, setStatus] = React.useState<DariLinkStatus>();
  React.useEffect(() => {
    let live = true;
    evaluationRequest<DariLinkStatus>(
      `/api/orgs/${encodeURIComponent(org)}/credentials/${credentialId}/dari-status`,
    )
      .then((next) => live && setStatus(next))
      .catch(
        (error: unknown) =>
          live &&
          setStatus({
            error: error instanceof Error ? error.message : "Could not reach Dari.",
            unlinked: false,
          }),
      );
    return () => {
      live = false;
    };
  }, [org, credentialId]);
  if (!status)
    return (
      <div role="status" aria-label="Loading Plans" className="border-t border-border px-4 py-3">
        <Skeleton className="h-4 w-48 max-w-full" />
      </div>
    );
  if ("error" in status)
    return (
      <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
        {status.error}
      </p>
    );
  return (
    <ul className="divide-y divide-border border-t border-border">
      {status.plans.map((plan) => (
        <PlanRow key={plan.id} plan={plan} />
      ))}
    </ul>
  );
}

function PlanRow({ plan }: { plan: Plan }) {
  const key = plan.kind === "api_key";
  const displayName = key ? plan.plan : (plan.account_email ?? plan.title);
  const details = [key ? null : plan.title].filter(Boolean);
  const limits = usageLimits(plan);
  return (
    <li className="px-4 py-3 transition-colors hover:bg-muted/30">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{displayName}</span>
          {plan.state === "plan_limit" ? (
            <span className="rounded-sm border border-border px-1.5 py-px text-xs text-faint">
              At Limit
            </span>
          ) : null}
        </div>
        {details.length > 0 ? (
          <p className="mt-1 truncate text-xs text-muted-foreground">{details.join(" · ")}</p>
        ) : null}
      </div>
      <UsageLimits limits={limits} />
    </li>
  );
}

type UsageLimit = { key: string; label: string; utilization: number; resetsAt: string };

const ONE_WEEK = 7 * 24 * 60;
const ONE_MONTH = 30 * 24 * 60;

/** What to call a window: 5 Hour, Weekly, Monthly, Claude Fable Weekly. */
function windowLabel(minutes: number, modelFamily?: string): string {
  const length =
    minutes === ONE_WEEK
      ? "Weekly"
      : minutes === ONE_MONTH
        ? "Monthly"
        : minutes % (24 * 60) === 0
          ? `${minutes / (24 * 60)} Day`
          : minutes % 60 === 0
            ? `${minutes / 60} Hour`
            : `${minutes} Minute`;
  return modelFamily === "fable" ? `Claude Fable ${length}` : length;
}

/** Every limit the plan runs against that has not reset, shortest window first. */
function usageLimits(plan: Plan): UsageLimit[] {
  const now = Date.now();
  return plan.usage
    .filter((window) => Date.parse(window.resets_at) > now)
    .sort((a, b) => a.window_minutes - b.window_minutes)
    .map((window) => ({
      key: `window-${window.model_family ?? "shared"}-${window.window_minutes}`,
      label: windowLabel(window.window_minutes, window.model_family),
      utilization: window.utilization,
      resetsAt: window.resets_at,
    }));
}

// One row per limit: its name, a meter that turns red at the limit, how much
// is used, and when it resets.
function UsageLimits({ limits }: { limits: UsageLimit[] }) {
  if (limits.length === 0) return null;
  return (
    <dl className="mt-3 grid max-w-2xl grid-cols-[minmax(0,1fr)_5.5rem_7rem] items-center gap-x-4 gap-y-2 text-xs sm:grid-cols-[8rem_minmax(3rem,1fr)_6rem_8rem]">
      {limits.map((limit) => {
        const percent = Math.round(limit.utilization * 100);
        const reached = percent >= 100;
        return (
          <div key={limit.key} className="contents">
            <dt className="truncate text-faint">{limit.label}</dt>
            {/* Phones keep the numbers and drop the bar. */}
            <dd className="hidden sm:block">
              {/* biome-ignore lint/a11y/useSemanticElements: a styled bar, as dari.dev draws it. */}
              <span
                role="meter"
                aria-label={`${limit.label} Usage`}
                aria-valuenow={percent}
                aria-valuemin={0}
                aria-valuemax={100}
                className="block h-1 w-full overflow-hidden rounded-full bg-muted"
              >
                <span
                  className={cn(
                    "block h-full rounded-full",
                    reached ? "bg-destructive" : "bg-brand",
                  )}
                  style={{ width: `${Math.max(percent, 1)}%` }}
                />
              </span>
            </dd>
            <dd
              className={cn(
                "whitespace-nowrap text-right tabular-nums",
                reached ? "text-destructive" : "text-foreground",
              )}
            >
              {reached ? "Limit Reached" : `${percent}%`}
            </dd>
            <dd className="whitespace-nowrap text-muted-foreground">
              Resets {formatResetTime(limit.resetsAt)}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

// Today's resets show the time, this week's the weekday, later ones the date:
// a weekday alone does not say which week a monthly window resets in.
function formatResetTime(value: string): string {
  const date = new Date(value);
  if (date.toDateString() === new Date().toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  return date.getTime() - Date.now() < ONE_WEEK * 60_000
    ? date.toLocaleDateString(undefined, { weekday: "short", hour: "numeric" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
