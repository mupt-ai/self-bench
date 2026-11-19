import { ArrowUpRight } from "lucide-react";
import React from "react";
import type { DariLinkStatus } from "../../../../src/gateway/dari-link/connection";
import { Skeleton } from "../LoadingSkeleton";
import { cn } from "../primitives/cn";
import { evaluationRequest } from "./api";

type Plan = Extract<DariLinkStatus, { plans: unknown }>["plans"][number];

/** A usage window's short name: `5h`, `Weekly`, `30-Day`. */
const windowName = (minutes: number) =>
  minutes === 10_080
    ? "Weekly"
    : minutes % 1_440 === 0
      ? `${minutes / 1_440}-Day`
      : minutes % 60 === 0
        ? `${minutes / 60}h`
        : `${minutes}m`;

/** `4:00 PM` today, `Fri 4:00 PM` on another day. */
function when(iso: string) {
  const date = new Date(iso);
  const today = date.toDateString() === new Date().toDateString();
  return date.toLocaleString(undefined, {
    ...(today ? {} : { weekday: "short" }),
    hour: "numeric",
    minute: "2-digit",
  });
}

const percent = (share: number) => Math.round(Math.min(1, Math.max(0, share)) * 100);

/**
 * Each plan or key a Dari connection shares, as Dari reports it now: whether runs can use it, and
 * how much of each usage window is spent. Status is by text and fill, not color alone.
 */
export function DariPlans({ org, credentialId }: { org: string; credentialId: string }) {
  const [status, setStatus] = React.useState<DariLinkStatus>();
  React.useEffect(() => {
    let live = true;
    evaluationRequest<DariLinkStatus>(
      `/api/orgs/${encodeURIComponent(org)}/credentials/${credentialId}/dari-status`,
    )
      .then((next) => live && setStatus(next))
      .catch((error: unknown) =>
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
      <div role="status" aria-label="Loading Plans" className="grid gap-2 px-4 pb-3.5">
        <Skeleton className="h-4 w-56 max-w-full" />
      </div>
    );
  if ("error" in status)
    return <p className="px-4 pb-3.5 text-sm text-muted-foreground">{status.error}</p>;
  return (
    <div className="px-4 pb-3.5">
      <ul className="divide-y divide-border rounded-md border border-border">
        {status.plans.map((plan) => (
          <PlanRow key={plan.id} plan={plan} />
        ))}
        {!status.plans.length && (
          <li className="px-3 py-2.5 text-sm text-muted-foreground">Nothing shared.</li>
        )}
      </ul>
      <a
        className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        href={status.manageUrl}
        target="_blank"
        rel="noreferrer"
      >
        Manage on Dari
        <ArrowUpRight className="size-3" aria-hidden="true" />
      </a>
    </div>
  );
}

function PlanRow({ plan }: { plan: Plan }) {
  const limited = plan.state === "plan_limit";
  const windows = [...plan.usage].sort((a, b) => a.window_minutes - b.window_minutes);
  return (
    <li className="flex flex-wrap items-center gap-x-6 gap-y-2 px-3 py-2.5 text-sm">
      <div className="min-w-0 flex-1 basis-40">
        <p className="truncate font-medium">{plan.kind === "api_key" ? plan.plan : plan.title}</p>
        {plan.account_email && (
          <p className="truncate text-xs text-muted-foreground">{plan.account_email}</p>
        )}
      </div>
      {windows.length > 0 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1" aria-label="Usage">
          {windows.map((window) => {
            const used = percent(window.utilization);
            return (
              <li
                key={`${window.window_minutes}-${window.model_family ?? ""}`}
                className="grid w-24 gap-1"
                title={`Resets ${when(window.resets_at)}`}
              >
                <span className="flex justify-between text-xs text-muted-foreground">
                  <span>
                    {windowName(window.window_minutes)}
                    {window.model_family ? ` ${window.model_family}` : ""}
                  </span>
                  <span
                    className={cn("tabular-nums", used >= 90 && "font-semibold text-foreground")}
                  >
                    {used}%
                  </span>
                </span>
                <span className="h-1 overflow-hidden rounded-full bg-border">
                  <span
                    className={cn(
                      "block h-full",
                      used >= 90 ? "bg-foreground" : "bg-muted-foreground",
                    )}
                    style={{ width: `${used}%` }}
                  />
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <p
        className={cn(
          "w-36 text-right text-xs",
          limited ? "font-semibold" : "text-muted-foreground",
        )}
      >
        {limited
          ? plan.available_at
            ? `At Limit Until ${when(plan.available_at)}`
            : "At Limit"
          : "Ready"}
      </p>
    </li>
  );
}
