import type { ReactNode } from "react";
import { cn } from "../primitives/cn";
import type { Flag } from "./results-alerts";
import type { Configuration, Outcome } from "./results-model";
import {
  configurationColor,
  configurationDetail,
  configurationLabel,
  outcomeLabels,
  statusLabels,
} from "./results-presentation";

/** Small marks the Results table is made of: pills, tags, flags and a configuration's name. */

const outcomePips: Record<Outcome, string> = {
  passed: "bg-success",
  failed: "bg-muted-foreground",
  unscored: "bg-warning",
  error: "bg-destructive",
  cancelled: "bg-muted-foreground/50",
  running: "bg-check",
  queued: "bg-muted-foreground/30",
};

function Pill({ pip, children }: { pip: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-xs font-medium whitespace-nowrap">
      <span data-pip className={cn("size-[7px] shrink-0", pip)} aria-hidden="true" />
      {children}
    </span>
  );
}

export function OutcomePill({ outcome }: { outcome: Outcome }) {
  return <Pill pip={outcomePips[outcome]}>{outcomeLabels[outcome]}</Pill>;
}

const statusPips: Record<Configuration["status"], string> = {
  running: "bg-check",
  queued: "bg-muted-foreground/30",
  done: "bg-success",
  cancelled: "bg-muted-foreground",
};

/** A configuration's status; one that needs attention says so instead, unless it was cancelled. */
export function StatusPill({
  status,
  attention,
}: {
  status: Configuration["status"];
  attention: boolean;
}) {
  return attention && status !== "cancelled" ? (
    <Pill pip="bg-destructive">Needs Attention</Pill>
  ) : (
    <Pill pip={statusPips[status]}>{statusLabels[status]}</Pill>
  );
}

const markTones: Record<Flag["severity"], string> = {
  bad: "text-destructive",
  warn: "text-warning",
  info: "text-muted-foreground",
  // The task's problem, not the configuration's.
  task: "text-destructive border-dashed",
};

const mark =
  "inline-block border border-current px-1.5 py-[3px] font-mono text-[10px] leading-none font-bold whitespace-nowrap";

export function Tag({ severity, children }: { severity: Flag["severity"]; children: ReactNode }) {
  return <span className={cn(mark, "mr-1.5 align-[1px]", markTones[severity])}>{children}</span>;
}

export function Flags({ flags }: { flags: readonly Flag[] }) {
  if (!flags.length) return null;
  return (
    <span className="flex flex-wrap justify-end gap-1">
      {flags.map((flag) => (
        <span key={`${flag.severity}/${flag.text}`} className={cn(mark, markTones[flag.severity])}>
          {flag.text}
        </span>
      ))}
    </span>
  );
}

/** The vendor's color, the model, and its reasoning, harness and route. */
export function ConfigurationName({ configuration }: { configuration: Configuration }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span
        className="size-2 shrink-0"
        style={{ background: configurationColor(configuration) }}
        aria-hidden="true"
      />
      <span className="min-w-0">
        <span className="block truncate font-semibold">{configurationLabel(configuration)}</span>
        <span
          className="block truncate font-mono text-xs font-normal text-muted-foreground"
          title={configurationDetail(configuration)}
        >
          {configurationDetail(configuration)}
        </span>
      </span>
    </span>
  );
}
