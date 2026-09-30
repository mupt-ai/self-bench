import { defaultPayloadConverter } from "@temporalio/client";
import type { TaskActivityDetail } from "./progress.js";

const PENDING_ACTIVITY_SCHEDULED = 1;
const PENDING_ACTIVITY_STARTED = 2;

interface ProtoTimestamp {
  seconds?: number | { toNumber(): number } | null;
  nanos?: number | null;
}
interface PendingActivity {
  state?: number | null;
  attempt?: number | null;
  maximumAttempts?: number | null;
  activityType?: { name?: string | null } | null;
  lastFailure?: { message?: string | null } | null;
  nextAttemptScheduleTime?: ProtoTimestamp | null;
  heartbeatDetails?: { payloads?: unknown[] | null } | null;
}

/** A workflow's current pending activity attempt: executing, or waiting on a retry. */
export function activityDetail(pending: readonly PendingActivity[]): TaskActivityDetail {
  const current =
    pending.find((entry) => entry.state === PENDING_ACTIVITY_STARTED) ??
    pending.find((entry) => entry.state === PENDING_ACTIVITY_SCHEDULED);
  if (!current) return { state: "unknown" };
  const detail: TaskActivityDetail = {
    state: current.state === PENDING_ACTIVITY_STARTED ? "running" : "queued",
  };
  if (current.activityType?.name) detail.activityType = current.activityType.name;
  if (current.attempt) detail.attempt = current.attempt;
  if (current.maximumAttempts) detail.maximumAttempts = current.maximumAttempts;
  const failure = normalizeFailure(current.lastFailure?.message);
  if (failure) detail.lastFailure = failure;
  const next = timestampToIso(current.nextAttemptScheduleTime);
  if (next) detail.nextAttemptAt = next;
  const cost = heartbeatCost(current.heartbeatDetails?.payloads?.[0]);
  if (cost) detail.cost = cost;
  return detail;
}

export function heartbeatCost(payload: unknown): TaskActivityDetail["cost"] {
  if (!payload) return undefined;
  try {
    const value = defaultPayloadConverter.fromPayload<unknown>(payload as never);
    if (!value || typeof value !== "object") return undefined;
    const cost = (value as { cost?: unknown }).cost;
    if (!cost || typeof cost !== "object") return undefined;
    const item = cost as Record<string, unknown>;
    if (
      typeof item.stage !== "string" ||
      item.stage.length === 0 ||
      !["estimated", "partial", "unpriced", "unknown"].includes(String(item.state)) ||
      typeof item.sandboxSeconds !== "number" ||
      !Number.isFinite(item.sandboxSeconds) ||
      item.sandboxSeconds < 0 ||
      typeof item.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(item.updatedAt))
    )
      return undefined;
    if (
      item.sandboxUsd !== undefined &&
      (typeof item.sandboxUsd !== "number" ||
        !Number.isFinite(item.sandboxUsd) ||
        item.sandboxUsd < 0)
    )
      return undefined;
    if (
      item.modelUsd !== undefined &&
      (typeof item.modelUsd !== "number" || !Number.isFinite(item.modelUsd) || item.modelUsd < 0)
    )
      return undefined;
    return cost as TaskActivityDetail["cost"];
  } catch {
    return undefined;
  }
}

/** Strips the per-attempt artifact reference so identical provider errors compare equal. */
function normalizeFailure(message: string | null | undefined): string | undefined {
  const text = message?.replace(/;\s*(partial )?log:\s*\S+/g, "").trim();
  return text ? text : undefined;
}

function timestampToIso(timestamp: ProtoTimestamp | null | undefined): string | undefined {
  if (!timestamp?.seconds) return undefined;
  const seconds =
    typeof timestamp.seconds === "number" ? timestamp.seconds : timestamp.seconds.toNumber();
  return new Date(seconds * 1_000 + Math.floor((timestamp.nanos ?? 0) / 1_000_000)).toISOString();
}
